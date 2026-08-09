import fs from "node:fs"
import path from "node:path"
import {
  cleanupRecordFromLegacy,
  WorkspaceCleanupService,
  type CleanupRecord,
  type WorkspaceCleanupResult,
} from "./workspace-cleanup"
import { leaseIsExpired, leaseIsRetained, readWorkspaceLease, type WorkspaceLease } from "./workspace-lease"
import { assertManifestIdentity, assertRuntimePath, canonicalPath } from "./workspace-path"

export const WORKSPACE_RETENTION_DEFAULTS = {
  successCancelMs: 10 * 60_000,
  retainedFailureMs: 24 * 60 * 60_000,
  quarantineMs: 7 * 24 * 60 * 60_000,
  orphanGraceMs: 60 * 60_000,
  runtimeSoftLimitBytes: Math.floor(1.5 * 1024 * 1024 * 1024),
  runtimeHardLimitBytes: 2 * 1024 * 1024 * 1024,
  maxTerminalReferences: 20,
  sweepIntervalMs: 5 * 60_000,
  maxItemsPerScan: 20,
  scanBudgetMs: 30_000,
} as const

export type WorkspaceTerminalState = "success" | "cancel" | "failure" | "quarantine"

export function retentionUntilFor(state: WorkspaceTerminalState, now = Date.now()) {
  const duration =
    state === "failure"
      ? WORKSPACE_RETENTION_DEFAULTS.retainedFailureMs
      : state === "quarantine"
        ? WORKSPACE_RETENTION_DEFAULTS.quarantineMs
        : WORKSPACE_RETENTION_DEFAULTS.successCancelMs
  return new Date(now + duration).toISOString()
}

export type RuntimeWatermark = "below_soft" | "soft" | "hard"

export async function runtimeWatermark(
  runtimeRoot: string,
  limits: Pick<
    typeof WORKSPACE_RETENTION_DEFAULTS,
    "runtimeSoftLimitBytes" | "runtimeHardLimitBytes"
  > = WORKSPACE_RETENTION_DEFAULTS,
): Promise<{ state: RuntimeWatermark; bytes: number }> {
  const bytes = await runtimeUsageBytes(runtimeRoot, limits.runtimeHardLimitBytes + 1)
  return {
    bytes,
    state:
      bytes >= limits.runtimeHardLimitBytes ? "hard" : bytes >= limits.runtimeSoftLimitBytes ? "soft" : "below_soft",
  }
}

export type WorkspaceSweepState = "active" | "idle" | "terminal" | "unknown"

export type WorkspaceSweepCandidate = {
  lease: WorkspaceLease
  leasePath: string
  manifestPath: string
  workspaceDirectory: string
}

export type WorkspaceSweepResult = {
  dryRun: boolean
  scanned: number
  removed: string[]
  preserved: string[]
  quarantined: string[]
  failures: Array<{ path: string; message: string }>
  skipped: string[]
  timedOut: boolean
}

export type WorkspaceSweeperOptions = {
  runtimeRoot: string
  now?: () => number
  maxItemsPerScan?: number
  scanBudgetMs?: number
  orphanGraceMs?: number
  retention?: Partial<typeof WORKSPACE_RETENTION_DEFAULTS>
  cleanupService?: WorkspaceCleanupService
  sessionState?: (lease: WorkspaceLease) => Promise<WorkspaceSweepState> | WorkspaceSweepState
  planState?: (lease: WorkspaceLease) => Promise<WorkspaceSweepState> | WorkspaceSweepState
  remove?: (candidate: WorkspaceSweepCandidate) => Promise<void>
  quarantine?: (candidate: WorkspaceSweepCandidate) => Promise<void>
}

type Queue = Record<string, CleanupRecord>

function queuePath(runtimeRoot: string) {
  return path.join(runtimeRoot, ".jyycode-cleanup-queue.json")
}

function queueKey(lease: WorkspaceLease) {
  return `${lease.root_session_id}\0${lease.task_id}\0${path.resolve(lease.workspace_directory)}`
}

function atomicWrite(pathname: string, value: unknown) {
  const temporary = `${pathname}.${process.pid}.${Date.now()}.tmp`
  fs.writeFileSync(temporary, JSON.stringify(value), "utf8")
  fs.renameSync(temporary, pathname)
}

function loadQueue(runtimeRoot: string): Queue {
  const pathname = queuePath(runtimeRoot)
  if (!fs.existsSync(pathname)) return {}
  try {
    const value = JSON.parse(fs.readFileSync(pathname, "utf8"))
    return value && typeof value === "object" && !Array.isArray(value) ? (value as Queue) : {}
  } catch {
    return {}
  }
}

function messageOf(error: unknown) {
  return error instanceof Error ? error.message : String(error)
}

function readManifestIdentity(pathname: string, lease: WorkspaceLease) {
  if (!fs.existsSync(pathname)) return false
  const value = JSON.parse(fs.readFileSync(pathname, "utf8"))
  assertManifestIdentity(value, {
    rootSessionId: lease.root_session_id,
    taskId: lease.task_id,
    name: path.basename(lease.workspace_directory),
  })
  return true
}

async function defaultRemove(candidate: WorkspaceSweepCandidate) {
  const targets = [
    candidate.workspaceDirectory,
    path.join(path.dirname(candidate.workspaceDirectory), `${path.basename(candidate.workspaceDirectory)}.baseline`),
    candidate.manifestPath,
    candidate.leasePath,
  ]
  for (const target of targets) {
    if (target === candidate.workspaceDirectory) await fs.promises.rm(target, { recursive: true, force: true })
    else await fs.promises.rm(target, { force: true })
  }
}

async function defaultQuarantine(candidate: WorkspaceSweepCandidate) {
  const root = path.dirname(candidate.workspaceDirectory)
  const targetRoot = path.join(root, ".quarantine")
  await fs.promises.mkdir(targetRoot, { recursive: true })
  const target = path.join(targetRoot, `${path.basename(candidate.workspaceDirectory)}-${Date.now()}`)
  await fs.promises.rename(candidate.workspaceDirectory, target)
  for (const sidecar of [candidate.manifestPath, candidate.leasePath]) await fs.promises.rm(sidecar, { force: true })
}

export async function directorySize(root: string, limit = Number.MAX_SAFE_INTEGER) {
  let total = 0
  async function walk(current: string): Promise<void> {
    if (total >= limit) return
    for (const entry of await fs.promises.readdir(current, { withFileTypes: true })) {
      if (total >= limit) return
      const pathname = path.join(current, entry.name)
      if (entry.isDirectory()) await walk(pathname)
      else if (entry.isFile()) total += (await fs.promises.stat(pathname)).size
    }
  }
  try {
    await walk(root)
  } catch {
    return total
  }
  return total
}

export async function runtimeUsageBytes(runtimeRoot: string, limit = Number.MAX_SAFE_INTEGER) {
  return directorySize(runtimeRoot, limit)
}

export async function canDispatchSnapshot(
  runtimeRoot: string,
  hardLimit = WORKSPACE_RETENTION_DEFAULTS.runtimeHardLimitBytes,
) {
  return (await runtimeUsageBytes(runtimeRoot, hardLimit + 1)) < hardLimit
}

export class WorkspaceSweeper {
  readonly runtimeRoot: string
  readonly now: () => number
  readonly maxItemsPerScan: number
  readonly scanBudgetMs: number
  readonly orphanGraceMs: number
  readonly retention: typeof WORKSPACE_RETENTION_DEFAULTS
  readonly cleanupService: WorkspaceCleanupService
  private readonly sessionState?: WorkspaceSweeperOptions["sessionState"]
  private readonly planState?: WorkspaceSweeperOptions["planState"]
  private readonly remove: NonNullable<WorkspaceSweeperOptions["remove"]>
  private readonly quarantine: NonNullable<WorkspaceSweeperOptions["quarantine"]>
  private queue: Queue
  private inFlight?: Promise<WorkspaceSweepResult>
  private interval?: ReturnType<typeof setInterval>

  constructor(input: WorkspaceSweeperOptions) {
    this.runtimeRoot = path.resolve(input.runtimeRoot)
    fs.mkdirSync(this.runtimeRoot, { recursive: true })
    this.now = input.now ?? Date.now
    this.retention = { ...WORKSPACE_RETENTION_DEFAULTS, ...input.retention }
    this.maxItemsPerScan = input.maxItemsPerScan ?? this.retention.maxItemsPerScan
    this.scanBudgetMs = input.scanBudgetMs ?? this.retention.scanBudgetMs
    this.orphanGraceMs = input.orphanGraceMs ?? this.retention.orphanGraceMs
    this.cleanupService = input.cleanupService ?? new WorkspaceCleanupService()
    this.sessionState = input.sessionState
    this.planState = input.planState
    this.remove = input.remove ?? defaultRemove
    this.quarantine = input.quarantine ?? defaultQuarantine
    this.queue = loadQueue(this.runtimeRoot)
  }

  private persistQueue() {
    atomicWrite(queuePath(this.runtimeRoot), this.queue)
  }

  private async updateQueue(key: string, record: CleanupRecord) {
    this.queue[key] = record
    this.persistQueue()
  }

  private candidates() {
    const output: WorkspaceSweepCandidate[] = []
    for (const entry of fs.readdirSync(this.runtimeRoot, { withFileTypes: true })) {
      if (!entry.isFile() || !entry.name.endsWith(".lease.json")) continue
      const leasePath = path.join(this.runtimeRoot, entry.name)
      try {
        const lease = readWorkspaceLease(leasePath)
        if (!lease) continue
        const workspaceDirectory = canonicalPath(lease.workspace_directory)
        assertRuntimePath({
          runtimeRoot: this.runtimeRoot,
          candidate: workspaceDirectory,
          label: "workspace sweep directory",
        })
        output.push({
          lease,
          leasePath,
          workspaceDirectory,
          manifestPath: path.join(this.runtimeRoot, `${path.basename(workspaceDirectory)}.manifest.json`),
        })
      } catch {
        // Invalid lease files are observed and left in place for diagnostics.
      }
    }
    return output.sort(
      (left, right) =>
        Date.parse(left.lease.retention_until ?? left.lease.expires_at) -
        Date.parse(right.lease.retention_until ?? right.lease.expires_at),
    )
  }

  scan(input: { dryRun?: boolean } = {}): Promise<WorkspaceSweepResult> {
    if (this.inFlight) return this.inFlight
    const operation = this.executeScan(input).finally(() => {
      this.inFlight = undefined
    })
    this.inFlight = operation
    return operation
  }

  private async executeScan(input: { dryRun?: boolean }): Promise<WorkspaceSweepResult> {
    const result: WorkspaceSweepResult = {
      dryRun: input.dryRun === true,
      scanned: 0,
      removed: [],
      preserved: [],
      quarantined: [],
      failures: [],
      skipped: [],
      timedOut: false,
    }
    const deadline = this.now() + this.scanBudgetMs
    for (const candidate of this.candidates().slice(0, this.maxItemsPerScan)) {
      if (this.now() >= deadline) {
        result.timedOut = true
        break
      }
      result.scanned++
      const lease = candidate.lease
      if (!leaseIsExpired(lease, this.now()) || leaseIsRetained(lease, this.now())) {
        result.preserved.push(candidate.workspaceDirectory)
        continue
      }
      let manifestValid = false
      try {
        manifestValid = readManifestIdentity(candidate.manifestPath, lease)
      } catch (error) {
        result.failures.push({ path: candidate.manifestPath, message: messageOf(error) })
        result.skipped.push(candidate.workspaceDirectory)
        continue
      }
      if (!manifestValid) {
        result.skipped.push(candidate.workspaceDirectory)
        continue
      }
      const session = (await this.sessionState?.(lease)) ?? "unknown"
      const plan = (await this.planState?.(lease)) ?? "unknown"
      if (session === "active" || plan === "active") {
        result.preserved.push(candidate.workspaceDirectory)
        continue
      }
      if (session === "unknown" || plan === "unknown") {
        if (
          session !== "unknown" ||
          plan !== "unknown" ||
          this.now() < Date.parse(lease.expires_at) + this.orphanGraceMs
        ) {
          result.preserved.push(candidate.workspaceDirectory)
          continue
        }
        if (input.dryRun) {
          result.quarantined.push(candidate.workspaceDirectory)
          continue
        }
        try {
          await this.quarantine(candidate)
          result.quarantined.push(candidate.workspaceDirectory)
        } catch (error) {
          result.failures.push({ path: candidate.workspaceDirectory, message: messageOf(error) })
        }
        continue
      }
      if (input.dryRun) {
        result.removed.push(candidate.workspaceDirectory)
        continue
      }
      const key = queueKey(lease)
      const queued = this.queue[key]
      if (queued?.next_retry_at && Date.parse(queued.next_retry_at) > this.now()) {
        result.preserved.push(candidate.workspaceDirectory)
        continue
      }
      let cleanup: WorkspaceCleanupResult
      try {
        cleanup = await this.cleanupService.run({
          rootSessionId: lease.root_session_id,
          taskId: lease.task_id,
          workspaceDirectory: candidate.workspaceDirectory,
          record: this.queue[key] ?? cleanupRecordFromLegacy(undefined, undefined, this.now),
          stop: async () => ({ state: "stopped", cancelled: true, idle: true, disposed: false, archived: true }),
          remove: () => this.remove(candidate),
          persist: (record) => this.updateQueue(key, record),
          now: this.now,
        })
      } catch (error) {
        result.failures.push({ path: candidate.workspaceDirectory, message: messageOf(error) })
        continue
      }
      if (cleanup.record.state === "completed") result.removed.push(candidate.workspaceDirectory)
      else
        result.failures.push({
          path: candidate.workspaceDirectory,
          message: cleanup.record.last_error?.message ?? cleanup.record.state,
        })
    }
    return result
  }

  start() {
    if (this.interval) return this
    void this.scan({ dryRun: true })
    this.interval = setInterval(() => void this.scan(), this.retention.sweepIntervalMs)
    if (typeof this.interval === "object" && "unref" in this.interval) this.interval.unref()
    return this
  }

  stop() {
    if (this.interval) clearInterval(this.interval)
    this.interval = undefined
  }
}

export * as WorkspaceSweeperModule from "./workspace-sweeper"
