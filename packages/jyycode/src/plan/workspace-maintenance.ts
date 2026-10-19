import fs from "node:fs"
import path from "node:path"
import { Database } from "@/storage/db"
import { SessionTable } from "@/session/session.sql"
import { PlanActivationTable } from "./activation.sql"
import { assertRuntimePath, canonicalPath } from "./workspace-path"
import { legacySnapshotRuntimeRoots } from "./workspace-storage"
import { leaseIsExpired, leaseIsRetained, readWorkspaceLease } from "./workspace-lease"
import {
  collectPlanReferences,
  purgeExpiredWorkspaceQuarantine,
  WorkspaceSweeper,
  WORKSPACE_RETENTION_DEFAULTS,
  type WorkspaceSweepResult,
} from "./workspace-sweeper"
import * as Log from "@jyycode-ai/core/util/log"

const log = Log.create({ service: "workspace-maintenance" })
const GENERATED =
  /^(?:jyycode-[A-Za-z0-9_-]+-[a-f0-9]{12}(?:\.baseline)?|baseline-[a-f0-9]{24}|\.jyycode-(?:merge|snapshot-staging)-[a-f0-9]{16})$/

export type WorkspaceMaintenanceContext = {
  planRoots: readonly string[]
  liveSessionIds: ReadonlySet<string>
  liveWorkspaceDirectories?: ReadonlySet<string>
}

export function workspaceMaintenanceContext(): WorkspaceMaintenanceContext {
  return Database.legacyQuery((db) => {
    const sessions = db.select({ id: SessionTable.id, directory: SessionTable.directory }).from(SessionTable).all()
    const activations = db.select().from(PlanActivationTable).all()
    const liveSessionIds = new Set(
      activations
        .filter((item) => item.state !== "settled" && item.lease_expires_at > Date.now())
        .map((item) => item.session_id),
    )
    return {
      planRoots: [...new Set(sessions.map((session) => session.directory))],
      liveSessionIds,
      liveWorkspaceDirectories: new Set(
        sessions.filter((session) => liveSessionIds.has(session.id)).map((session) => session.directory),
      ),
    }
  })
}

export type WorkspaceMaintenanceResult = {
  roots: Array<{ root: string; sweep: WorkspaceSweepResult }>
  quarantined: string[]
  purged: string[]
  failures: Array<{ path: string; message: string }>
}

/** Metadata-only discovery runs in the background; dispatch never inventories other projects. */
export class PlanWorkspaceMaintenance {
  private readonly dataRoot: string
  private readonly now: () => number
  private readonly context: () => WorkspaceMaintenanceContext
  private readonly sweepers = new Map<string, WorkspaceSweeper>()
  private references = new Map<string, { active: boolean; terminal: boolean }>()
  private liveSessionIds: ReadonlySet<string> = new Set()
  private inFlight?: Promise<WorkspaceMaintenanceResult>
  private interval?: ReturnType<typeof setInterval>
  private lastRoot?: string
  private readonly lastArtifact = new Map<string, string>()

  constructor(input: { dataRoot: string; now?: () => number; context?: () => WorkspaceMaintenanceContext }) {
    this.dataRoot = path.resolve(input.dataRoot)
    this.now = input.now ?? Date.now
    this.context = input.context ?? workspaceMaintenanceContext
  }

  private roots() {
    const base = path.join(this.dataRoot, "plan-workspaces", "projects")
    const roots = legacySnapshotRuntimeRoots(this.dataRoot).filter((root) => fs.existsSync(root))
    if (fs.existsSync(base)) {
      assertRuntimePath({ runtimeRoot: this.dataRoot, candidate: base, label: "project workspace storage" })
      for (const entry of fs.readdirSync(base, { withFileTypes: true }))
        if (entry.isDirectory() && /^[a-f0-9]{24}$/.test(entry.name)) roots.push(path.join(base, entry.name))
    }
    for (const root of roots)
      assertRuntimePath({ runtimeRoot: this.dataRoot, candidate: root, label: "workspace storage" })
    return roots.sort()
  }

  scan(input: { dryRun?: boolean } = {}): Promise<WorkspaceMaintenanceResult> {
    if (this.inFlight) return this.inFlight
    this.inFlight = this.executeScan(input).finally(() => {
      this.inFlight = undefined
    })
    return this.inFlight
  }

  private async executeScan(input: { dryRun?: boolean }): Promise<WorkspaceMaintenanceResult> {
    const result: WorkspaceMaintenanceResult = { roots: [], quarantined: [], purged: [], failures: [] }
    try {
      const context = this.context()
      this.liveSessionIds = context.liveSessionIds
      const roots = this.roots()
      const planRoots = new Set(context.planRoots.map((root) => canonicalPath(root)))
      // Baselines retain the source project even if its session was archived or
      // belongs to another database channel. Only read shallow JSON metadata.
      for (const root of roots) {
        for (const entry of fs.readdirSync(root)) {
          if (!/^baseline-[a-f0-9]{24}\.source\.json$/.test(entry)) continue
          const source = JSON.parse(fs.readFileSync(path.join(root, entry), "utf8"))
          if (typeof source.source_root === "string") planRoots.add(canonicalPath(source.source_root))
        }
      }
      this.references = new Map(
        [...collectPlanReferences([...planRoots], roots, true, this.now())].map(([directory, reference]) => [
          canonicalPath(directory),
          reference,
        ]),
      )
      const protectedPaths = new Set([...this.references].filter(([, ref]) => ref.active).map(([pathname]) => pathname))
      for (const directory of context.liveWorkspaceDirectories ?? []) protectedPaths.add(canonicalPath(directory))
      const previous = roots.indexOf(this.lastRoot ?? "")
      const start = previous < 0 ? 0 : (previous + 1) % roots.length
      const batch = [...roots.slice(start), ...roots.slice(0, start)].slice(0, 20)
      const deadline = this.now() + WORKSPACE_RETENTION_DEFAULTS.scanBudgetMs
      for (const root of batch) {
        if (this.now() >= deadline) break
        this.lastRoot = root
        let sweeper = this.sweepers.get(root)
        if (!sweeper) {
          sweeper = new WorkspaceSweeper({
            runtimeRoot: root,
            now: this.now,
            allowOrphanQuarantine: true,
            purgeQuarantine: false,
            sessionState: (lease) => (this.liveSessionIds.has(lease.session_id) ? "active" : "idle"),
            planState: (lease) => {
              const reference = this.references.get(canonicalPath(lease.workspace_directory))
              return reference?.active ? "active" : reference?.terminal ? "terminal" : "unknown"
            },
          })
          this.sweepers.set(root, sweeper)
        }
        const sweep = await sweeper.scan(input)
        result.roots.push({ root, sweep })
        result.failures.push(...sweep.failures)
        await this.reclaimUnleased(root, protectedPaths, input.dryRun === true, result, deadline)
        const purged = await purgeExpiredWorkspaceQuarantine({
          runtimeRoot: root,
          now: this.now(),
          protectedPaths,
          dryRun: input.dryRun,
        })
        result.purged.push(...purged.removed)
        result.failures.push(
          ...purged.failures.map((pathname) => ({ path: pathname, message: "quarantine deletion failed" })),
        )
      }
    } catch (error) {
      // Incomplete plan/database metadata must never be interpreted as orphaned work.
      result.failures.push({ path: this.dataRoot, message: error instanceof Error ? error.message : String(error) })
    }
    return result
  }

  private async reclaimUnleased(
    root: string,
    protectedPaths: ReadonlySet<string>,
    dryRun: boolean,
    result: WorkspaceMaintenanceResult,
    deadline: number,
  ) {
    const entries = fs.readdirSync(root, { withFileTypes: true })
    const referencedBaselines = new Set<string>()
    let unreadableManifest = false
    for (const entry of entries) {
      if (!entry.name.endsWith(".manifest.json")) continue
      // Even a currently unreferenced child may still need its baseline for
      // recovery. Reclaim the baseline only after its last sidecar is gone.
      try {
        const manifest = JSON.parse(fs.readFileSync(path.join(root, entry.name), "utf8"))
        if (typeof manifest.baseline_id === "string") referencedBaselines.add(manifest.baseline_id)
      } catch (error) {
        unreadableManifest = true
        result.failures.push({ path: path.join(root, entry.name), message: String(error) })
      }
    }
    const candidates = entries.filter((entry) => {
      if (entry.isDirectory()) return GENERATED.test(entry.name)
      if (!entry.isFile()) return false
      const owner = entry.name.replace(/\.(?:manifest|source|lease)\.json$/, "")
      return owner !== entry.name && GENERATED.test(owner) && !fs.existsSync(path.join(root, owner))
    })
    const previous = candidates.findIndex((entry) => entry.name === this.lastArtifact.get(root))
    const start = previous < 0 ? 0 : (previous + 1) % candidates.length
    const batch = [...candidates.slice(start), ...candidates.slice(0, start)].slice(0, 20)
    for (const entry of batch) {
      if (this.now() >= deadline) break
      this.lastArtifact.set(root, entry.name)
      const directory = path.join(root, entry.name)
      if (unreadableManifest && entry.name.startsWith("baseline-")) continue
      const owner = directory.replace(/\.(?:manifest|source|lease)\.json$/, "")
      if (protectedPaths.has(directory) || protectedPaths.has(owner) || referencedBaselines.has(entry.name)) continue
      const leasePath = `${owner}.lease.json`
      if (directory !== leasePath && fs.existsSync(leasePath)) continue
      try {
        if (directory === leasePath) {
          const lease = readWorkspaceLease(leasePath)
          if (
            !lease ||
            !leaseIsExpired(lease, this.now()) ||
            leaseIsRetained(lease, this.now()) ||
            this.liveSessionIds.has(lease.session_id)
          )
            continue
          if (this.now() - Date.parse(lease.expires_at) < WORKSPACE_RETENTION_DEFAULTS.orphanGraceMs) continue
        }
        const safe = assertRuntimePath({ runtimeRoot: root, candidate: directory, label: "orphan workspace" })
        const stat = await fs.promises.lstat(safe)
        if (this.now() - Math.max(stat.mtimeMs, stat.birthtimeMs) < WORKSPACE_RETENTION_DEFAULTS.orphanGraceMs) continue
        // Recheck after asynchronous I/O: a child can acquire its lease during scanning.
        if (directory !== leasePath && fs.existsSync(leasePath)) continue
        if (dryRun) {
          result.quarantined.push(directory)
          continue
        }
        const quarantineRoot = path.join(root, ".quarantine")
        assertRuntimePath({ runtimeRoot: root, candidate: quarantineRoot, label: "workspace quarantine" })
        const target = path.join(quarantineRoot, `${entry.name}-${this.now()}`)
        await fs.promises.mkdir(target, { recursive: true })
        await fs.promises.rename(safe, path.join(target, entry.name))
        for (const suffix of [".manifest.json", ".source.json"])
          if (fs.existsSync(directory + suffix)) {
            assertRuntimePath({ runtimeRoot: root, candidate: directory + suffix, label: "workspace sidecar" })
            await fs.promises.rename(directory + suffix, path.join(target, entry.name + suffix))
          }
        await fs.promises.utimes(target, new Date(this.now()), new Date(this.now()))
        result.quarantined.push(directory)
      } catch (error) {
        result.failures.push({ path: directory, message: error instanceof Error ? error.message : String(error) })
      }
    }
  }

  start() {
    if (this.interval) return this
    const scan = () => {
      void this.scan()
        .then((result) => {
          if (result.failures.length) log.warn("workspace maintenance incomplete", { failures: result.failures.length })
        })
        .catch((error) => log.warn("workspace maintenance failed", { error: String(error) }))
    }
    scan()
    this.interval = setInterval(scan, WORKSPACE_RETENTION_DEFAULTS.sweepIntervalMs)
    this.interval.unref?.()
    return this
  }

  stop() {
    if (this.interval) clearInterval(this.interval)
    this.interval = undefined
  }
}

export * as WorkspaceMaintenance from "./workspace-maintenance"
