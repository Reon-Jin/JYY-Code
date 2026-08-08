import crypto from "node:crypto"
import fs from "node:fs"
import path from "node:path"
import { Effect } from "effect"
import { Worktree } from "@/worktree"
import { assertInside } from "./path-guard"

export type ChildWorkspaceMode = "worktree" | "snapshot" | "shared_compat"
export type CleanupPolicy = "on_success" | "on_cancel" | "retain_on_failure"

export type ChildWorkspaceProject = {
  root: string
  vcs: "git" | "none"
  sharedCompat?: boolean
}

export type WorkspaceReservation = {
  rootSessionId: string
  taskId: string
  name: string
  mode: ChildWorkspaceMode
  root: string
  directory: string | null
  created_at: string | null
  cleanup: CleanupPolicy
}

export type BaselineManifestEntry = {
  relative_path: string
  hash: string
  mode: "file" | "symlink"
}

export type WorkspaceHandle = WorkspaceReservation & {
  directory: string
  baseline_manifest: BaselineManifestEntry[]
}

export type ChangeSetEntry = {
  relative_path: string
  kind: "added" | "modified" | "deleted"
  source_hash: string | null
  baseline_hash: string | null
}

export interface WorktreeAdapter {
  makeWorktreeInfo(input: { name: string; detached: true }): Promise<{ name: string; directory: string }>
  createFromInfo(info: { name: string; directory: string }): Promise<void>
  remove(directory: string): Promise<boolean>
}

/** Bridge the Effect Worktree service into the promise-based workspace manager. */
export function worktreeAdapter(input: {
  service: Pick<Worktree.Interface, "makeWorktreeInfo" | "createFromInfo" | "remove">
  run<A, E>(effect: Effect.Effect<A, E>): Promise<A>
}): WorktreeAdapter {
  return {
    makeWorktreeInfo: (options) => input.run(input.service.makeWorktreeInfo(options)),
    createFromInfo: (info) => input.run(input.service.createFromInfo(info)),
    remove: (directory) => input.run(input.service.remove({ directory })),
  }
}

export class ChildWorkspaceError extends Error {
  readonly directory: string | null
  readonly recoverable: boolean

  constructor(message: string, input: { directory?: string | null; recoverable?: boolean } = {}) {
    super(message)
    this.name = "ChildWorkspaceError"
    this.directory = input.directory ?? null
    this.recoverable = input.recoverable ?? true
  }
}

type ChildWorkspaceOptions = {
  project: ChildWorkspaceProject
  runtimeRoot: string
  worktree?: WorktreeAdapter
  now?: () => number
}

function safeToken(value: string) {
  const readable = value.replace(/[^A-Za-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "")
  return readable.slice(0, 32) || "session"
}

function deterministicName(rootSessionId: string, taskId: string) {
  const digest = crypto.createHash("sha256").update(`${rootSessionId}\0${taskId}`).digest("hex").slice(0, 12)
  return `jyycode-${safeToken(rootSessionId)}-${safeToken(taskId)}-${digest}`
}

function hashFile(pathname: string) {
  return crypto.createHash("sha256").update(fs.readFileSync(pathname)).digest("hex")
}

function walkFiles(root: string, current = root): BaselineManifestEntry[] {
  const entries: BaselineManifestEntry[] = []
  for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
    if (entry.name === ".git") continue
    const pathname = path.join(current, entry.name)
    const relative = path.relative(root, pathname)
    if (entry.isDirectory()) entries.push(...walkFiles(root, pathname))
    else if (entry.isSymbolicLink()) entries.push({ relative_path: relative, hash: fs.readlinkSync(pathname), mode: "symlink" })
    else if (entry.isFile()) entries.push({ relative_path: relative, hash: hashFile(pathname), mode: "file" })
  }
  return entries.sort((left, right) => left.relative_path.localeCompare(right.relative_path))
}

function isInside(root: string, target: string) {
  const relative = path.relative(path.resolve(root), path.resolve(target))
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative))
}

export class ChildWorkspace {
  private readonly project: ChildWorkspaceProject
  private readonly runtimeRoot: string
  private readonly worktree?: WorktreeAdapter
  private readonly now: () => number
  private readonly reservations = new Map<string, WorkspaceHandle | WorkspaceReservation>()

  constructor(options: ChildWorkspaceOptions) {
    this.project = { ...options.project, root: path.resolve(options.project.root) }
    this.runtimeRoot = path.resolve(options.runtimeRoot)
    this.worktree = options.worktree
    this.now = options.now ?? Date.now
    fs.mkdirSync(this.runtimeRoot, { recursive: true })
  }

  capability(project = this.project): ChildWorkspaceMode {
    if (project.sharedCompat) return "shared_compat"
    return project.vcs === "git" ? "worktree" : "snapshot"
  }

  reserve(rootSessionId: string, taskId: string): WorkspaceReservation {
    const key = `${rootSessionId}\0${taskId}`
    const existing = this.reservations.get(key)
    if (existing) return structuredClone(existing)
    const mode = this.capability()
    const reservation: WorkspaceReservation = {
      rootSessionId,
      taskId,
      name: deterministicName(rootSessionId, taskId),
      mode,
      root: this.project.root,
      directory: mode === "shared_compat" ? this.project.root : path.join(this.runtimeRoot, deterministicName(rootSessionId, taskId)),
      created_at: null,
      cleanup: mode === "shared_compat" ? "retain_on_failure" : "on_success",
    }
    this.reservations.set(key, reservation)
    return structuredClone(reservation)
  }

  async create(reservation: WorkspaceReservation): Promise<WorkspaceHandle> {
    const key = `${reservation.rootSessionId}\0${reservation.taskId}`
    const known = this.reservations.get(key)
    if (known && "baseline_manifest" in known) return structuredClone(known)
    if (reservation.mode === "shared_compat") {
      const handle: WorkspaceHandle = {
        ...reservation,
        directory: this.project.root,
        created_at: reservation.created_at ?? new Date(this.now()).toISOString(),
        baseline_manifest: walkFiles(this.project.root),
      }
      this.reservations.set(key, handle)
      return structuredClone(handle)
    }
    if (!reservation.directory) throw new ChildWorkspaceError("隔离 workspace 缺少 directory")
    try {
      let directory = reservation.directory
      if (reservation.mode === "worktree") {
        if (!this.worktree) throw new ChildWorkspaceError("Git 项目缺少 Worktree service")
        const info = await this.worktree.makeWorktreeInfo({ name: reservation.name, detached: true })
        if (!isInside(this.runtimeRoot, info.directory))
          throw new ChildWorkspaceError("Worktree directory 必须位于 runtime workspace 根目录", {
            directory: info.directory,
          })
        await this.worktree.createFromInfo(info)
        directory = path.resolve(info.directory)
      } else {
        if (!isInside(this.runtimeRoot, directory))
          throw new ChildWorkspaceError("snapshot directory 必须位于 runtime workspace 根目录")
        if (!fs.existsSync(directory)) fs.cpSync(this.project.root, directory, { recursive: true, force: false })
      }
      const canonical = fs.existsSync(directory) ? fs.realpathSync.native(directory) : path.resolve(directory)
      const handle: WorkspaceHandle = {
        ...reservation,
        directory: canonical,
        created_at: reservation.created_at ?? new Date(this.now()).toISOString(),
        baseline_manifest: walkFiles(canonical),
      }
      this.reservations.set(key, handle)
      return structuredClone(handle)
    } catch (error) {
      throw error instanceof ChildWorkspaceError
        ? error
        : new ChildWorkspaceError(error instanceof Error ? error.message : String(error), {
            directory: reservation.directory,
          })
    }
  }

  async snapshot(rootSessionId: string, taskId: string) {
    const reservation = this.reserve(rootSessionId, taskId)
    if (reservation.mode !== "snapshot") throw new ChildWorkspaceError("当前项目不是 snapshot capability")
    return this.create(reservation)
  }

  canonical(directory: string) {
    return fs.existsSync(directory) ? fs.realpathSync.native(directory) : path.resolve(directory)
  }

  diff(snapshot: WorkspaceHandle, scope: string): ChangeSetEntry[] {
    assertInside(snapshot.directory, path.isAbsolute(scope) ? scope : path.join(snapshot.directory, scope), "output_scope")
    const scopePath = path.resolve(snapshot.directory, scope)
    const baseline = new Map(snapshot.baseline_manifest.map((entry) => [entry.relative_path, entry]))
    const current = new Map(walkFiles(snapshot.directory).map((entry) => [entry.relative_path, entry]))
    const relativeScope = path.relative(snapshot.directory, scopePath)
    const inScope = (relative: string) =>
      relativeScope === "" || relative === relativeScope || relative.startsWith(`${relativeScope}${path.sep}`)
    const changes: ChangeSetEntry[] = []
    for (const [relative, entry] of current) {
      if (!inScope(relative)) continue
      const previous = baseline.get(relative)
      if (!previous) changes.push({ relative_path: relative, kind: "added", source_hash: entry.hash, baseline_hash: null })
      else if (previous.hash !== entry.hash || previous.mode !== entry.mode)
        changes.push({ relative_path: relative, kind: "modified", source_hash: entry.hash, baseline_hash: previous.hash })
    }
    for (const [relative, entry] of baseline)
      if (inScope(relative) && !current.has(relative))
        changes.push({ relative_path: relative, kind: "deleted", source_hash: null, baseline_hash: entry.hash })
    return changes.sort((left, right) => left.relative_path.localeCompare(right.relative_path))
  }

  async remove(directory: string) {
    const canonical = this.canonical(directory)
    const match = [...this.reservations.entries()].find(
      ([, reservation]) => reservation.directory !== null && this.canonical(reservation.directory) === canonical,
    )
    const entry = match?.[1]
    if (!entry || entry.mode === "shared_compat")
      throw new ChildWorkspaceError("拒绝清理未经当前 Plan metadata 创建的 workspace", { directory, recoverable: false })
    try {
      if (entry.mode === "worktree") {
        if (!this.worktree) throw new ChildWorkspaceError("Git 项目缺少 Worktree service", { directory })
        await this.worktree.remove(canonical)
      } else if (fs.existsSync(canonical)) fs.rmSync(canonical, { recursive: true, force: true })
      if (match) this.reservations.delete(match[0])
      return true
    } catch (error) {
      throw new ChildWorkspaceError(error instanceof Error ? error.message : String(error), { directory })
    }
  }

  get(rootSessionId: string, taskId: string) {
    const value = this.reservations.get(`${rootSessionId}\0${taskId}`)
    return value ? structuredClone(value) : undefined
  }
}

export * as ChildWorkspaceModule from "./child-workspace"
