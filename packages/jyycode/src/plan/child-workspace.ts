import crypto from "node:crypto"
import { execFileSync } from "node:child_process"
import fs from "node:fs"
import path from "node:path"
import { Effect } from "effect"
import { Worktree } from "@/worktree"
import { assertInside } from "./path-guard"
import { assertManifestIdentity, assertRuntimePath, assertWorkspaceIdentity, isPathInside } from "./workspace-path"
import {
  buildSnapshotManifest,
  DEFAULT_SNAPSHOT_MANIFEST_LIMITS,
  type SnapshotManifest,
  type SnapshotManifestEntry,
  type SnapshotManifestLimits,
} from "./snapshot-manifest"
import { preflightWorkspaceBudget, type WorkspaceBudget } from "./workspace-budget"

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
  baseline_directory?: string | null
  baseline_manifest_path?: string | null
  baseline_manifest_hash?: string | null
  baseline_manifest_size?: number | null
  baseline_manifest_file_count?: number | null
  baseline_id?: string | null
  source_manifest_hash?: string | null
  source_revision?: string | null
}

export type BaselineManifestEntry = SnapshotManifestEntry
export type SnapshotLimits = SnapshotManifestLimits

export const DEFAULT_SNAPSHOT_LIMITS: SnapshotLimits = DEFAULT_SNAPSHOT_MANIFEST_LIMITS

export type WorkspaceHandle = WorkspaceReservation & {
  directory: string
  baseline_directory: string | null
  baseline_manifest_path: string | null
  baseline_manifest_hash: string | null
  baseline_manifest_size: number | null
  baseline_manifest_file_count: number | null
  baseline_id: string | null
  source_manifest_hash: string | null
  source_revision: string | null
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
  readonly code?: string

  constructor(message: string, input: { directory?: string | null; recoverable?: boolean; code?: string } = {}) {
    super(message)
    this.name = "ChildWorkspaceError"
    this.directory = input.directory ?? null
    this.recoverable = input.recoverable ?? true
    this.code = input.code
  }
}

type ChildWorkspaceOptions = {
  project: ChildWorkspaceProject
  runtimeRoot: string
  worktree?: WorktreeAdapter
  now?: () => number
  snapshotLimits?: Partial<SnapshotLimits>
  snapshotExclude?: readonly string[]
  snapshotInclude?: readonly string[]
  workspaceBudget?: { softLimitBytes?: number; hardLimitBytes?: number }
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

function hashManifest(manifest: BaselineManifestEntry[]) {
  return crypto.createHash("sha256").update(JSON.stringify(manifest)).digest("hex")
}

type IgnoreRule = {
  pattern: string
  regex: RegExp
  negated: boolean
  directoryOnly: boolean
}

const HARD_EXCLUDED_DIRECTORIES = new Set([
  ".git",
  ".jyycode",
  "node_modules",
  "bower_components",
  "vendor",
  "build",
  "dist",
  "coverage",
  "cache",
  ".cache",
  ".next",
  ".turbo",
  ".parcel-cache",
  "target",
  "tmp",
  "temp",
  "__pycache__",
  ".pytest_cache",
])

function isCredentialName(relative: string) {
  const name = path.posix.basename(relative.replaceAll("\\", "/")).toLowerCase()
  if (name === ".env" || (name.startsWith(".env.") && ![".env.example", ".env.sample", ".env.template"].includes(name)))
    return true
  if (name.startsWith("credentials") || name.startsWith("secrets")) return true
  if (name === "id_rsa" || name.startsWith("id_rsa.")) return true
  return [".pem", ".key", ".p12", ".pfx", ".crt", ".secret", ".token"].some((suffix) => name.endsWith(suffix))
}

function hardExcluded(relative: string, directory: boolean) {
  const parts = relative.replaceAll("\\", "/").split("/")
  if (parts.some((part) => HARD_EXCLUDED_DIRECTORIES.has(part.toLowerCase()))) return true
  return !directory && isCredentialName(relative)
}

export function isSnapshotPathAllowed(relative: string, directory = false) {
  return !hardExcluded(relative, directory)
}

function globRegex(pattern: string) {
  let source = ""
  for (let index = 0; index < pattern.length; index++) {
    const character = pattern[index]
    if (character === "*" && pattern[index + 1] === "*") {
      index++
      if (pattern[index + 1] === "/") {
        index++
        source += "(?:.*/)?"
      } else source += ".*"
    } else if (character === "*") source += "[^/]*"
    else if (character === "?") source += "[^/]"
    else source += /[\\^$+?.()|{}[\]]/.test(character) ? `\\${character}` : character
  }
  return new RegExp(`^${source}$`)
}

function readIgnoreRules(root: string): IgnoreRule[] {
  const ignorePath = path.join(root, ".gitignore")
  if (!fs.existsSync(ignorePath)) return []
  return fs
    .readFileSync(ignorePath, "utf8")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith("#"))
    .map((line) => {
      const negated = line.startsWith("!")
      const raw = (negated ? line.slice(1) : line).replaceAll("\\", "/")
      const directoryOnly = raw.endsWith("/")
      const pattern = raw.replace(/^\/+/, "").replace(/\/$/, "")
      return { pattern, regex: globRegex(pattern), negated, directoryOnly }
    })
    .filter((rule) => rule.pattern.length > 0)
}

function ignoredByRules(relative: string, directory: boolean, rules: IgnoreRule[]) {
  const normalized = relative.replaceAll("\\", "/")
  let ignored = false
  for (const rule of rules) {
    if (rule.directoryOnly && !directory && !normalized.startsWith(`${rule.pattern}/`)) continue
    const matches = rule.pattern.includes("/")
      ? rule.regex.test(normalized) || normalized.startsWith(`${rule.pattern}/`)
      : rule.regex.test(path.posix.basename(normalized))
    if (matches) ignored = !rule.negated
  }
  return ignored
}

function gitPaths(root: string, args: string[]) {
  const output = execFileSync("git", args, { cwd: root, encoding: "buffer", stdio: ["ignore", "pipe", "ignore"] })
  return output
    .toString("utf8")
    .split("\0")
    .filter(Boolean)
    .map((value) => value.replaceAll("/", path.sep))
}

function walkCandidatePaths(root: string, current = root, rules = readIgnoreRules(root)): string[] {
  const output: string[] = []
  for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
    const pathname = path.join(current, entry.name)
    const relative = path.relative(root, pathname)
    if (hardExcluded(relative, entry.isDirectory())) continue
    if (entry.isDirectory()) {
      if (!ignoredByRules(relative, true, rules)) output.push(...walkCandidatePaths(root, pathname, rules))
    } else if ((entry.isFile() || entry.isSymbolicLink()) && !ignoredByRules(relative, false, rules))
      output.push(relative)
  }
  return output
}

function candidatePaths(root: string, vcs: "git" | "none") {
  if (vcs === "git") {
    try {
      return [
        ...new Set([
          ...gitPaths(root, ["ls-files", "-z"]),
          ...gitPaths(root, ["ls-files", "--others", "--exclude-standard", "-z"]),
        ]),
      ].filter((relative) => !hardExcluded(relative, false))
    } catch {
      // A test adapter or a newly-created project may advertise Git before
      // the repository is available. The non-Git policy is still bounded.
    }
  }
  return walkCandidatePaths(root)
}

function snapshotManifest(root: string, vcs: "git" | "none", limits: SnapshotLimits): BaselineManifestEntry[] {
  const paths = candidatePaths(root, vcs).sort((left, right) => left.localeCompare(right))
  if (paths.length > limits.maxFileCount)
    throw new ChildWorkspaceError(
      `child snapshot exceeds the file-count limit (${paths.length} > ${limits.maxFileCount}); narrow the task scope`,
      { directory: root },
    )
  let totalBytes = 0
  const manifest: BaselineManifestEntry[] = []
  for (const relativePath of paths) {
    const pathname = path.resolve(root, relativePath)
    if (!isInside(root, pathname))
      throw new ChildWorkspaceError("child snapshot path escapes workspace", { directory: pathname })
    const stat = fs.lstatSync(pathname)
    if (stat.isDirectory()) continue
    if (!stat.isFile() && !stat.isSymbolicLink())
      throw new ChildWorkspaceError(`unsupported workspace entry: ${relativePath}`, { directory: pathname })
    const size = stat.isSymbolicLink() ? Buffer.byteLength(fs.readlinkSync(pathname)) : stat.size
    if (size > limits.maxFileBytes)
      throw new ChildWorkspaceError(
        `child snapshot file exceeds the per-file limit (${relativePath}: ${size} > ${limits.maxFileBytes}); narrow the task scope`,
        { directory: pathname },
      )
    totalBytes += size
    if (totalBytes > limits.maxTotalBytes)
      throw new ChildWorkspaceError(
        `child snapshot exceeds the total-byte limit (${totalBytes} > ${limits.maxTotalBytes}); narrow the task scope`,
        { directory: root },
      )
    manifest.push({
      relative_path: relativePath,
      hash: stat.isSymbolicLink() ? fs.readlinkSync(pathname) : hashFile(pathname),
      size,
      mode: stat.isSymbolicLink() ? "symlink" : "file",
    })
  }
  return manifest
}

function manifestSize(manifest: BaselineManifestEntry[]) {
  return manifest.reduce((total, entry) => total + entry.size, 0)
}

function manifestPath(runtimeRoot: string, name: string) {
  return path.join(runtimeRoot, `${name}.manifest.json`)
}

function writeManifest(
  pathname: string,
  manifest: BaselineManifestEntry[],
  identity?: { rootSessionId: string; taskId: string; name: string; baselineId?: string | null },
) {
  const payload = JSON.stringify({
    version: 1,
    ...(identity
      ? {
          root_session_id: identity.rootSessionId,
          task_id: identity.taskId,
          name: identity.name,
          ...(identity.baselineId ? { baseline_id: identity.baselineId } : {}),
        }
      : {}),
    entries: manifest,
  })
  fs.writeFileSync(pathname, payload, "utf8")
  return { hash: hashManifest(manifest), size: manifestSize(manifest), fileCount: manifest.length }
}

function readManifest(
  pathname: string,
  expectedHash?: string | null,
  identity?: { rootSessionId: string; taskId: string; name: string; baselineId?: string | null },
) {
  try {
    const value = JSON.parse(fs.readFileSync(pathname, "utf8")) as {
      version?: unknown
      entries?: unknown
      baseline_id?: unknown
    }
    if (value.version !== 1 || !Array.isArray(value.entries)) throw new Error("invalid manifest")
    if (identity) assertManifestIdentity(value, identity)
    if (identity?.baselineId !== undefined && value.baseline_id !== identity.baselineId)
      throw new ChildWorkspaceError("baseline manifest baseline_id does not match the cleanup request", {
        directory: pathname,
        recoverable: false,
        code: "PATH_IDENTITY_MISMATCH",
      })
    const entries = value.entries as BaselineManifestEntry[]
    if (
      entries.some(
        (entry) =>
          !entry ||
          typeof entry.relative_path !== "string" ||
          entry.relative_path.replaceAll("\\", "/").startsWith("/") ||
          /^[A-Za-z]:\//.test(entry.relative_path.replaceAll("\\", "/")) ||
          entry.relative_path
            .replaceAll("\\", "/")
            .split("/")
            .some((part) => part === ".." || part.length === 0) ||
          typeof entry.hash !== "string" ||
          typeof entry.size !== "number" ||
          !Number.isSafeInteger(entry.size) ||
          !["file", "symlink"].includes(entry.mode),
      )
    )
      throw new Error("invalid manifest entry")
    const hash = hashManifest(entries)
    if (expectedHash && expectedHash !== hash) throw new Error("manifest hash mismatch")
    return { entries, hash, size: manifestSize(entries), fileCount: entries.length }
  } catch (error) {
    throw new ChildWorkspaceError(
      `baseline manifest is unreadable: ${error instanceof Error ? error.message : String(error)}`,
      {
        directory: pathname,
        recoverable: error instanceof ChildWorkspaceError ? error.recoverable : false,
        code: error && typeof error === "object" && "code" in error ? String(error.code) : undefined,
      },
    )
  }
}

function walkFiles(root: string, current = root): BaselineManifestEntry[] {
  const entries: BaselineManifestEntry[] = []
  for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
    if (entry.name === ".git") continue
    const pathname = path.join(current, entry.name)
    const relative = path.relative(root, pathname)
    if (entry.isDirectory()) entries.push(...walkFiles(root, pathname))
    else if (entry.isSymbolicLink()) {
      const link = assertSafeSymlink(root, pathname)
      entries.push({ relative_path: relative, hash: link, size: Buffer.byteLength(link), mode: "symlink" })
    } else if (entry.isFile()) {
      entries.push({
        relative_path: relative,
        hash: hashFile(pathname),
        size: fs.statSync(pathname).size,
        mode: "file",
      })
    } else throw new ChildWorkspaceError(`不支持的 workspace 文件类型: ${relative}`)
  }
  return entries.sort((left, right) => left.relative_path.localeCompare(right.relative_path))
}

function assertSafeSymlink(root: string, pathname: string) {
  const target = fs.readlinkSync(pathname)
  const resolved = path.resolve(path.dirname(pathname), target)
  if (!isInside(root, resolved))
    throw new ChildWorkspaceError("拒绝复制指向 workspace 外部的 symlink", { directory: pathname })
  return target
}

function copyTree(source: string, target: string, root = source) {
  if (!fs.existsSync(target)) fs.mkdirSync(target, { recursive: true })
  for (const entry of fs.readdirSync(source, { withFileTypes: true })) {
    if (entry.name === ".git") continue
    const sourcePath = path.join(source, entry.name)
    const targetPath = path.join(target, entry.name)
    if (entry.isDirectory()) {
      fs.mkdirSync(targetPath, { recursive: true })
      copyTree(sourcePath, targetPath, root)
    } else if (entry.isSymbolicLink()) {
      const link = assertSafeSymlink(root, sourcePath)
      if (fs.existsSync(targetPath) || fs.lstatSync(targetPath, { throwIfNoEntry: false }))
        fs.rmSync(targetPath, { recursive: true, force: true })
      try {
        fs.symlinkSync(link, targetPath)
      } catch (error) {
        throw new ChildWorkspaceError(error instanceof Error ? error.message : String(error), { directory: targetPath })
      }
    } else if (entry.isFile()) {
      fs.mkdirSync(path.dirname(targetPath), { recursive: true })
      fs.copyFileSync(sourcePath, targetPath)
    } else throw new ChildWorkspaceError(`不支持的 workspace 文件类型: ${path.relative(root, sourcePath)}`)
  }
}

function copyManifest(source: string, target: string, manifest: BaselineManifestEntry[]) {
  if (!fs.existsSync(target)) fs.mkdirSync(target, { recursive: true })
  for (const item of manifest) {
    const sourcePath = path.join(source, item.relative_path)
    const targetPath = path.join(target, item.relative_path)
    fs.mkdirSync(path.dirname(targetPath), { recursive: true })
    if (item.mode === "symlink") {
      const link = assertSafeSymlink(source, sourcePath)
      if (fs.existsSync(targetPath) || fs.lstatSync(targetPath, { throwIfNoEntry: false }))
        fs.rmSync(targetPath, { recursive: true, force: true })
      try {
        fs.symlinkSync(link, targetPath)
      } catch (error) {
        throw new ChildWorkspaceError(error instanceof Error ? error.message : String(error), { directory: targetPath })
      }
    } else fs.copyFileSync(sourcePath, targetPath)
  }
}

function clearTreeExceptGit(directory: string, preserveGit = true) {
  if (!fs.existsSync(directory)) return
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    if (preserveGit && entry.name === ".git") continue
    fs.rmSync(path.join(directory, entry.name), { recursive: true, force: true })
  }
}

function isInside(root: string, target: string) {
  return isPathInside(root, target)
}

export class ChildWorkspace {
  private readonly project: ChildWorkspaceProject
  private readonly runtimeRoot: string
  private readonly worktree?: WorktreeAdapter
  private readonly now: () => number
  private readonly snapshotLimits: SnapshotLimits
  private readonly snapshotExclude: readonly string[]
  private readonly snapshotInclude: readonly string[]
  private readonly workspaceBudget: { softLimitBytes?: number; hardLimitBytes?: number }
  private readonly reservations = new Map<string, WorkspaceHandle | WorkspaceReservation>()
  private readonly pendingBaselines = new Map<string, { directory: string; manifest: SnapshotManifest }>()
  private readonly baselineOperations = new Map<
    string,
    Promise<{ baselineId: string; directory: string; manifest: SnapshotManifest }>
  >()
  private pendingManifest?: SnapshotManifest
  private pendingManifestUses = 0

  constructor(options: ChildWorkspaceOptions) {
    this.project = { ...options.project, root: path.resolve(options.project.root) }
    this.runtimeRoot = path.resolve(options.runtimeRoot)
    this.worktree = options.worktree
    this.now = options.now ?? Date.now
    this.snapshotLimits = { ...DEFAULT_SNAPSHOT_LIMITS, ...options.snapshotLimits }
    this.snapshotExclude = options.snapshotExclude ?? []
    this.snapshotInclude = options.snapshotInclude ?? []
    this.workspaceBudget = options.workspaceBudget ?? {}
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
      directory:
        mode === "shared_compat"
          ? this.project.root
          : path.join(this.runtimeRoot, deterministicName(rootSessionId, taskId)),
      created_at: null,
      cleanup: mode === "shared_compat" ? "retain_on_failure" : "on_success",
      baseline_directory: null,
      baseline_manifest_path: null,
      baseline_manifest_hash: null,
      baseline_manifest_size: null,
      baseline_manifest_file_count: null,
      baseline_id: null,
      source_manifest_hash: null,
      source_revision: null,
    }
    this.reservations.set(key, reservation)
    return structuredClone(reservation)
  }

  private async sourceManifest() {
    if (this.pendingManifest && this.pendingManifestUses > 0) {
      this.pendingManifestUses--
      const manifest = this.pendingManifest
      if (this.pendingManifestUses === 0) this.pendingManifest = undefined
      return manifest
    }
    return buildSnapshotManifest({
      root: this.project.root,
      runtimeRoot: this.runtimeRoot,
      limits: this.snapshotLimits,
      exclude: this.snapshotExclude,
      include: this.snapshotInclude,
    })
  }

  async preflight(reservations: readonly WorkspaceReservation[]) {
    const snapshots = reservations.filter((reservation) => reservation.mode === "snapshot")
    if (snapshots.length === 0) return undefined
    const manifest = await buildSnapshotManifest({
      root: this.project.root,
      runtimeRoot: this.runtimeRoot,
      limits: this.snapshotLimits,
      exclude: this.snapshotExclude,
      include: this.snapshotInclude,
    })
    const budget = await preflightWorkspaceBudget({
      runtimeRoot: this.runtimeRoot,
      manifest,
      taskCount: snapshots.length,
      ...this.workspaceBudget,
    })
    this.pendingManifest = manifest
    this.pendingManifestUses = snapshots.length
    return { manifest, budget }
  }

  private async ensureSharedBaseline(manifest: SnapshotManifest) {
    const baselineId = `baseline-${manifest.source_manifest_hash.slice(0, 24)}`
    const existing = this.pendingBaselines.get(manifest.source_manifest_hash)
    if (existing) return { baselineId, ...existing }
    const running = this.baselineOperations.get(manifest.source_manifest_hash)
    if (running) return running
    const operation = (async () => {
      const directory = path.join(this.runtimeRoot, baselineId)
      const sourcePath = path.join(this.runtimeRoot, `${baselineId}.source.json`)
      if (!fs.existsSync(directory)) {
        const staging = path.join(
          this.runtimeRoot,
          `.jyycode-snapshot-staging-${crypto.randomBytes(8).toString("hex")}`,
        )
        let published = false
        try {
          fs.mkdirSync(staging, { recursive: true })
          copyManifest(this.project.root, staging, manifest.entries)
          fs.writeFileSync(path.join(staging, "source.json"), JSON.stringify(manifest), "utf8")
          fs.renameSync(staging, directory)
          published = true
          fs.renameSync(path.join(directory, "source.json"), sourcePath)
        } catch (error) {
          fs.rmSync(staging, { recursive: true, force: true })
          if (published) fs.rmSync(directory, { recursive: true, force: true })
          throw error
        }
      } else if (fs.existsSync(sourcePath)) {
        const saved = JSON.parse(fs.readFileSync(sourcePath, "utf8")) as { source_manifest_hash?: unknown }
        if (saved.source_manifest_hash !== manifest.source_manifest_hash)
          throw new ChildWorkspaceError("immutable baseline manifest hash changed", {
            directory,
            recoverable: false,
            code: "PATH_IDENTITY_MISMATCH",
          })
      }
      const value = { directory, manifest }
      this.pendingBaselines.set(manifest.source_manifest_hash, value)
      return { baselineId, ...value }
    })()
    this.baselineOperations.set(manifest.source_manifest_hash, operation)
    try {
      return await operation
    } finally {
      this.baselineOperations.delete(manifest.source_manifest_hash)
    }
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
        baseline_directory: null,
        baseline_manifest_path: null,
        baseline_manifest_hash: null,
        baseline_manifest_size: null,
        baseline_manifest_file_count: null,
        baseline_id: null,
        source_manifest_hash: null,
        source_revision: reservation.source_revision ?? null,
        baseline_manifest: walkFiles(this.project.root),
      }
      this.reservations.set(key, handle)
      return structuredClone(handle)
    }
    if (!reservation.directory) throw new ChildWorkspaceError("隔离 workspace 缺少 directory")
    let snapshotBaselineId: string | undefined
    let snapshotManifestPath: string | undefined
    try {
      const directory = path.resolve(reservation.directory)
      if (!isInside(this.runtimeRoot, directory))
        throw new ChildWorkspaceError("child workspace 必须位于 runtime workspace 根目录", { directory })
      const baselineDirectory = path.resolve(
        reservation.baseline_directory ?? path.join(this.runtimeRoot, `${reservation.name}.baseline`),
      )
      if (!isInside(this.runtimeRoot, baselineDirectory) || baselineDirectory === directory)
        throw new ChildWorkspaceError("baseline directory 必须是 runtime 根目录下的独立 sibling", {
          directory: baselineDirectory,
        })

      if (fs.existsSync(baselineDirectory)) {
        const loaded = this.load({ ...reservation, directory, baseline_directory: baselineDirectory })
        if (loaded) {
          this.reservations.set(key, loaded)
          return structuredClone(loaded)
        }
      }

      const sourceManifest = reservation.mode === "snapshot" ? await this.sourceManifest() : undefined
      const baselineManifest =
        sourceManifest?.entries ?? snapshotManifest(this.project.root, this.project.vcs, this.snapshotLimits)
      const shared = sourceManifest ? await this.ensureSharedBaseline(sourceManifest) : undefined
      snapshotBaselineId = shared?.baselineId
      const effectiveBaselineDirectory = shared?.directory ?? baselineDirectory
      if (!shared) {
        fs.mkdirSync(effectiveBaselineDirectory, { recursive: true })
        clearTreeExceptGit(effectiveBaselineDirectory, false)
        copyManifest(this.project.root, effectiveBaselineDirectory, baselineManifest)
      }
      const baselineManifestHash = shared?.manifest.source_manifest_hash ?? hashManifest(baselineManifest)
      const baselineManifestPath = manifestPath(this.runtimeRoot, reservation.name)
      snapshotManifestPath = baselineManifestPath
      const manifestMetadata = writeManifest(baselineManifestPath, baselineManifest, {
        rootSessionId: reservation.rootSessionId,
        taskId: reservation.taskId,
        name: reservation.name,
        baselineId: shared?.baselineId,
      })

      if (reservation.mode === "worktree") {
        if (!this.worktree) throw new ChildWorkspaceError("Git 项目缺少 Worktree service")
        const info = await this.worktree.makeWorktreeInfo({ name: reservation.name, detached: true })
        if (!isInside(this.runtimeRoot, info.directory))
          throw new ChildWorkspaceError("Worktree directory 必须位于 runtime workspace 根目录", {
            directory: info.directory,
          })
        await this.worktree.createFromInfo(info)
        if (path.resolve(info.directory) !== directory && fs.existsSync(directory))
          throw new ChildWorkspaceError("Worktree adapter 返回了与 reservation 不同的 directory", {
            directory: info.directory,
          })
        const worktreeDirectory = path.resolve(info.directory)
        clearTreeExceptGit(worktreeDirectory)
        copyManifest(effectiveBaselineDirectory, worktreeDirectory, baselineManifest)
        const handle: WorkspaceHandle = {
          ...reservation,
          directory: worktreeDirectory,
          created_at: reservation.created_at ?? new Date(this.now()).toISOString(),
          baseline_directory: effectiveBaselineDirectory,
          baseline_manifest_path: baselineManifestPath,
          baseline_manifest_hash: baselineManifestHash,
          baseline_manifest_size: manifestMetadata.size,
          baseline_manifest_file_count: manifestMetadata.fileCount,
          baseline_id: shared?.baselineId ?? reservation.baseline_id ?? null,
          source_manifest_hash: shared?.manifest.source_manifest_hash ?? reservation.source_manifest_hash ?? null,
          source_revision: reservation.source_revision ?? null,
          baseline_manifest: baselineManifest,
        }
        this.reservations.set(key, handle)
        return structuredClone(handle)
      } else {
        if (!fs.existsSync(directory)) fs.mkdirSync(directory, { recursive: true })
        clearTreeExceptGit(directory, false)
        copyManifest(effectiveBaselineDirectory, directory, baselineManifest)
      }
      const canonical = fs.existsSync(directory) ? fs.realpathSync.native(directory) : directory
      const handle: WorkspaceHandle = {
        ...reservation,
        directory: canonical,
        created_at: reservation.created_at ?? new Date(this.now()).toISOString(),
        baseline_directory: effectiveBaselineDirectory,
        baseline_manifest_path: baselineManifestPath,
        baseline_manifest_hash: baselineManifestHash,
        baseline_manifest_size: manifestMetadata.size,
        baseline_manifest_file_count: manifestMetadata.fileCount,
        baseline_id: shared?.baselineId ?? reservation.baseline_id ?? null,
        source_manifest_hash: shared?.manifest.source_manifest_hash ?? reservation.source_manifest_hash ?? null,
        source_revision: reservation.source_revision ?? null,
        baseline_manifest: baselineManifest,
      }
      this.reservations.set(key, handle)
      return structuredClone(handle)
    } catch (error) {
      if (reservation.mode === "snapshot") {
        const cleanupDirectory = path.resolve(reservation.directory)
        if (isInside(this.runtimeRoot, cleanupDirectory)) fs.rmSync(cleanupDirectory, { recursive: true, force: true })
        if (snapshotManifestPath) fs.rmSync(snapshotManifestPath, { force: true })
        if (
          snapshotBaselineId &&
          snapshotManifestPath &&
          !this.hasOtherBaselineReference(snapshotBaselineId, snapshotManifestPath)
        ) {
          fs.rmSync(path.join(this.runtimeRoot, snapshotBaselineId), { recursive: true, force: true })
          fs.rmSync(path.join(this.runtimeRoot, `${snapshotBaselineId}.source.json`), { force: true })
        }
      }
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

  load(reservation: WorkspaceReservation): WorkspaceHandle | undefined {
    if (reservation.mode === "shared_compat") {
      const handle = {
        ...reservation,
        directory: this.project.root,
        baseline_directory: null,
        baseline_manifest_path: null,
        baseline_manifest_hash: null,
        baseline_manifest_size: null,
        baseline_manifest_file_count: null,
        baseline_id: null,
        source_manifest_hash: null,
        source_revision: reservation.source_revision ?? null,
        baseline_manifest: walkFiles(this.project.root),
      }
      this.reservations.set(`${reservation.rootSessionId}\0${reservation.taskId}`, handle)
      return handle
    }
    const directory = reservation.directory ? path.resolve(reservation.directory) : null
    let baselineId = reservation.baseline_id ?? undefined
    let baselineDirectory = reservation.baseline_directory
      ? path.resolve(reservation.baseline_directory)
      : path.join(this.runtimeRoot, `${reservation.name}.baseline`)
    if (!directory || !isInside(this.runtimeRoot, directory)) return undefined
    const savedManifestPath = path.resolve(
      reservation.baseline_manifest_path ?? manifestPath(this.runtimeRoot, reservation.name),
    )
    if (!isInside(this.runtimeRoot, savedManifestPath))
      throw new ChildWorkspaceError("baseline manifest must be inside the runtime workspace", {
        directory: savedManifestPath,
      })
    if (!fs.existsSync(directory) || !fs.existsSync(savedManifestPath)) return undefined
    if (!fs.existsSync(baselineDirectory)) {
      try {
        const metadata = JSON.parse(fs.readFileSync(savedManifestPath, "utf8")) as { baseline_id?: unknown }
        if (typeof metadata.baseline_id === "string") {
          baselineId = metadata.baseline_id
          baselineDirectory = path.join(this.runtimeRoot, metadata.baseline_id)
        }
      } catch {
        return undefined
      }
    }
    if (!isInside(this.runtimeRoot, baselineDirectory) || !fs.existsSync(baselineDirectory)) return undefined
    const saved = readManifest(savedManifestPath, reservation.baseline_manifest_hash, {
      rootSessionId: reservation.rootSessionId,
      taskId: reservation.taskId,
      name: reservation.name,
      baselineId,
    })
    if (
      reservation.baseline_manifest_size !== undefined &&
      reservation.baseline_manifest_size !== null &&
      reservation.baseline_manifest_size !== saved.size
    )
      throw new ChildWorkspaceError("baseline manifest size mismatch", { directory: savedManifestPath })
    if (
      reservation.baseline_manifest_file_count !== undefined &&
      reservation.baseline_manifest_file_count !== null &&
      reservation.baseline_manifest_file_count !== saved.fileCount
    )
      throw new ChildWorkspaceError("baseline manifest file-count mismatch", { directory: savedManifestPath })
    const baselineManifest = saved.entries
    const handle = {
      ...reservation,
      directory: fs.realpathSync.native(directory),
      baseline_directory: fs.realpathSync.native(baselineDirectory),
      baseline_manifest_path: fs.realpathSync.native(savedManifestPath),
      baseline_manifest_hash: reservation.baseline_manifest_hash ?? saved.hash,
      baseline_manifest_size: reservation.baseline_manifest_size ?? saved.size,
      baseline_manifest_file_count: reservation.baseline_manifest_file_count ?? saved.fileCount,
      baseline_id: baselineId ?? null,
      source_manifest_hash: reservation.source_manifest_hash ?? reservation.baseline_manifest_hash ?? null,
      source_revision: reservation.source_revision ?? null,
      baseline_manifest: baselineManifest,
    }
    this.reservations.set(`${reservation.rootSessionId}\0${reservation.taskId}`, handle)
    return handle
  }

  canonical(directory: string) {
    return fs.existsSync(directory) ? fs.realpathSync.native(directory) : path.resolve(directory)
  }

  diff(snapshot: WorkspaceHandle, scope: string): ChangeSetEntry[] {
    assertInside(
      snapshot.directory,
      path.isAbsolute(scope) ? scope : path.join(snapshot.directory, scope),
      "output_scope",
    )
    const scopePath = path.resolve(snapshot.directory, scope)
    const normalizeRelative = (value: string) => value.replaceAll("\\", "/")
    const baseline = new Map(snapshot.baseline_manifest.map((entry) => [normalizeRelative(entry.relative_path), entry]))
    const current = new Map(
      snapshotManifest(snapshot.directory, "none", this.snapshotLimits).map((entry) => [
        normalizeRelative(entry.relative_path),
        entry,
      ]),
    )
    const relativeScope = normalizeRelative(path.relative(snapshot.directory, scopePath))
    const inScope = (relative: string) =>
      relativeScope === "" || relative === relativeScope || relative.startsWith(`${relativeScope}/`)
    const changes: ChangeSetEntry[] = []
    for (const [relative, entry] of current) {
      if (!inScope(relative)) continue
      const previous = baseline.get(relative)
      if (!previous)
        changes.push({
          relative_path: entry.relative_path,
          kind: "added",
          source_hash: entry.hash,
          baseline_hash: null,
        })
      else if (previous.hash !== entry.hash || previous.mode !== entry.mode)
        changes.push({
          relative_path: entry.relative_path,
          kind: "modified",
          source_hash: entry.hash,
          baseline_hash: previous.hash,
        })
    }
    for (const [relative, entry] of baseline)
      if (inScope(relative) && !current.has(relative))
        changes.push({
          relative_path: entry.relative_path,
          kind: "deleted",
          source_hash: null,
          baseline_hash: entry.hash,
        })
    return changes.sort((left, right) => left.relative_path.localeCompare(right.relative_path))
  }

  private hasOtherBaselineReference(baselineId: string, manifestPathname: string) {
    for (const entry of fs.readdirSync(this.runtimeRoot, { withFileTypes: true })) {
      if (!entry.isFile() || !entry.name.endsWith(".manifest.json")) continue
      const pathname = path.join(this.runtimeRoot, entry.name)
      if (path.resolve(pathname) === path.resolve(manifestPathname)) continue
      try {
        const value = JSON.parse(fs.readFileSync(pathname, "utf8")) as Record<string, unknown>
        if (value.baseline_id === baselineId) return true
      } catch {
        // A malformed unrelated sidecar is not evidence that this baseline is
        // still referenced; its owning cleanup will quarantine it separately.
      }
    }
    return false
  }

  async remove(directory: string) {
    let canonical: string
    try {
      canonical = assertRuntimePath({
        runtimeRoot: this.runtimeRoot,
        candidate: directory,
        label: "workspace directory",
      })
    } catch (error) {
      throw new ChildWorkspaceError(error instanceof Error ? error.message : String(error), {
        directory,
        recoverable: false,
        code: error && typeof error === "object" && "code" in error ? String(error.code) : undefined,
      })
    }
    const match = [...this.reservations.entries()].find(
      ([, reservation]) => reservation.directory !== null && this.canonical(reservation.directory) === canonical,
    )
    const entry = match?.[1]
    if (!entry || entry.mode === "shared_compat")
      throw new ChildWorkspaceError("拒绝清理未经当前 Plan metadata 创建的 workspace", {
        directory,
        recoverable: false,
      })
    try {
      assertWorkspaceIdentity({
        actual: entry,
        expected: {
          rootSessionId: entry.rootSessionId,
          taskId: entry.taskId,
          name: deterministicName(entry.rootSessionId, entry.taskId),
        },
      })
    } catch (error) {
      throw new ChildWorkspaceError(error instanceof Error ? error.message : String(error), {
        directory,
        recoverable: false,
        code: error && typeof error === "object" && "code" in error ? String(error.code) : undefined,
      })
    }
    let baseline: string | undefined
    let manifest: string | undefined
    try {
      if (entry.baseline_directory) {
        baseline = assertRuntimePath({
          runtimeRoot: this.runtimeRoot,
          candidate: entry.baseline_directory,
          label: "baseline directory",
        })
        if (baseline === path.resolve(this.project.root))
          throw new ChildWorkspaceError("鎷掔粷娓呯悊涓嶅畨鍏ㄧ殑 baseline directory", {
            directory: baseline,
            recoverable: false,
          })
      }
      if (entry.baseline_manifest_path) {
        manifest = assertRuntimePath({
          runtimeRoot: this.runtimeRoot,
          candidate: entry.baseline_manifest_path,
          label: "baseline manifest",
        })
        if (fs.existsSync(manifest))
          readManifest(manifest, entry.baseline_manifest_hash, {
            rootSessionId: entry.rootSessionId,
            taskId: entry.taskId,
            name: entry.name,
            baselineId: entry.baseline_id ?? undefined,
          })
      }
    } catch (error) {
      throw new ChildWorkspaceError(error instanceof Error ? error.message : String(error), {
        directory,
        recoverable: error instanceof ChildWorkspaceError ? error.recoverable : false,
        code: error && typeof error === "object" && "code" in error ? String(error.code) : undefined,
      })
    }
    try {
      if (entry.mode === "worktree") {
        if (!this.worktree) throw new ChildWorkspaceError("Git 项目缺少 Worktree service", { directory })
        await this.worktree.remove(canonical)
      } else if (fs.existsSync(canonical)) fs.rmSync(canonical, { recursive: true, force: true })
      if (entry.baseline_directory) {
        const baseline = assertRuntimePath({
          runtimeRoot: this.runtimeRoot,
          candidate: entry.baseline_directory,
          label: "baseline directory",
        })
        if (!isInside(this.runtimeRoot, baseline) || baseline === path.resolve(this.project.root))
          throw new ChildWorkspaceError("拒绝清理不安全的 baseline directory", {
            directory: baseline,
            recoverable: false,
          })
        if (
          !entry.baseline_id ||
          !entry.baseline_manifest_path ||
          !this.hasOtherBaselineReference(entry.baseline_id, entry.baseline_manifest_path)
        ) {
          if (fs.existsSync(baseline)) fs.rmSync(baseline, { recursive: true, force: true })
          if (entry.baseline_id)
            fs.rmSync(path.join(this.runtimeRoot, `${entry.baseline_id}.source.json`), { force: true })
        }
      }
      if (entry.baseline_manifest_path) {
        const manifest = assertRuntimePath({
          runtimeRoot: this.runtimeRoot,
          candidate: entry.baseline_manifest_path,
          label: "baseline manifest",
        })
        if (fs.existsSync(manifest))
          readManifest(manifest, entry.baseline_manifest_hash, {
            rootSessionId: entry.rootSessionId,
            taskId: entry.taskId,
            name: entry.name,
            baselineId: entry.baseline_id ?? undefined,
          })
        if (fs.existsSync(manifest)) fs.rmSync(manifest, { force: true })
      }
      if (match) this.reservations.delete(match[0])
      return true
    } catch (error) {
      throw new ChildWorkspaceError(error instanceof Error ? error.message : String(error), {
        directory,
        recoverable: error instanceof ChildWorkspaceError ? error.recoverable : undefined,
        code: error && typeof error === "object" && "code" in error ? String(error.code) : undefined,
      })
    }
  }

  get(rootSessionId: string, taskId: string) {
    const value = this.reservations.get(`${rootSessionId}\0${taskId}`)
    return value ? structuredClone(value) : undefined
  }
}

export * as ChildWorkspaceModule from "./child-workspace"
