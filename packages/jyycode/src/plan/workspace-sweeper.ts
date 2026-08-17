import fs from "node:fs"
import path from "node:path"
import { createHash } from "node:crypto"
import {
  cleanupRecordFromLegacy,
  WorkspaceCleanupService,
  type CleanupRecord,
  type WorkspaceCleanupResult,
} from "./workspace-cleanup"
import { leaseIsExpired, leaseIsRetained, readWorkspaceLease, type WorkspaceLease } from "./workspace-lease"
import { assertManifestIdentity, assertRuntimePath, canonicalPath } from "./workspace-path"
import { readPlanFileSync, type PlanFile, type PlanTask } from "./schema"

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
  inventoryMaxEntries: 100_000,
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

export type WorkspaceInventoryCategory = "active" | "cleanup_failed" | "orphan" | "terminal_reference" | "unknown"

export type WorkspaceInventoryAction = "preserve" | "retry_cleanup" | "quarantine" | "manual_review"

export type WorkspaceInventoryItem = {
  cleanup_id: string
  category: WorkspaceInventoryCategory
  recommended_action: WorkspaceInventoryAction
  source_root: string
  directory: string
  name: string
  files: number
  dirs: number
  bytes: number
  cleanup_attempts?: number
  created_at: string | null
  last_modified_at: string | null
  root_session_id: string | null
  task_id: string | null
  session_id: string | null
  lease: {
    expires_at: string
    heartbeat_at: string
    terminal_state?: WorkspaceLease["terminal_state"]
  } | null
  reason: string
  eligible: boolean
  identity: {
    realpath: string
    size: number
    mtime_ms: number
  }
}

export type WorkspaceInventoryTelemetry = {
  gauges: {
    workspace_bytes: number
    workspace_dirs: number
    active_leases: number
    background_running: number
    pty_running: number
  }
  counters: {
    cleanup_attempts: number
    cleanup_failures: number
    cleanup_age_ms: number
    quota_rejection: number
    child_termination: number
    tool_timeout: number
    kill_failed: number
    mcp_idle_timeout: number
    mcp_total_timeout: number
  }
}

export type WorkspaceInventoryResult = {
  project: string
  runtime_root: string
  legacy_roots: string[]
  index_path: string
  generated_at: string
  scanned: number
  truncated: boolean
  files: number
  dirs: number
  bytes: number
  active_leases: number
  categories: Record<WorkspaceInventoryCategory, WorkspaceInventoryItem[]>
  items: WorkspaceInventoryItem[]
  telemetry: WorkspaceInventoryTelemetry
}

export type WorkspaceInventoryOptions = {
  project?: string
  runtimeRoot: string
  legacyRoots?: readonly string[]
  planRoots?: readonly string[]
  sessionIds?: readonly string[]
  now?: number | (() => number)
  orphanGraceMs?: number
  maxEntries?: number
  writeIndex?: boolean
}

export type WorkspaceMigrationApplyResult = {
  operation_id: string
  applied: string[]
  quarantined: string[]
  skipped: Array<{ cleanup_id: string; reason: string }>
  failures: Array<{ cleanup_id: string; code: string }>
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

export function workspaceInventoryIndexPath(runtimeRoot: string) {
  return path.join(path.resolve(runtimeRoot), ".jyycode-plan-workspace-index.json")
}

function loadInventoryIndex(runtimeRoot: string) {
  const pathname = workspaceInventoryIndexPath(runtimeRoot)
  if (!fs.existsSync(pathname)) return undefined
  try {
    const value = JSON.parse(fs.readFileSync(pathname, "utf8")) as { items?: unknown }
    return Array.isArray(value.items) ? value.items : undefined
  } catch {
    return undefined
  }
}

function inventoryNow(input: WorkspaceInventoryOptions) {
  return typeof input.now === "function" ? input.now() : (input.now ?? Date.now())
}

function isGeneratedDirectory(name: string) {
  return name.startsWith("jyycode-") || name.startsWith("baseline-") || name.startsWith(".jyycode-")
}

function cleanupId(input: { root: string; directory: string; lease?: WorkspaceLease; stat: fs.Stats }) {
  const identity = [
    path.resolve(input.root),
    path.resolve(input.directory),
    input.lease?.root_session_id ?? "",
    input.lease?.task_id ?? "",
    input.lease?.session_id ?? "",
    input.stat.ino,
    input.stat.size,
    input.stat.mtimeMs,
  ].join("\0")
  return `pw_${createHash("sha256").update(identity).digest("hex").slice(0, 20)}`
}

function planTaskIsActive(task: PlanTask) {
  if (task.merge?.status === "merged") return false
  return (
    task.status === "dispatched" ||
    task.status === "running" ||
    task.status === "reported" ||
    task.status === "approved" ||
    (task.merge !== undefined &&
      (task.merge.status === "pending" ||
        task.merge.status === "running" ||
        task.merge.status === "conflict" ||
        task.merge.cleanup !== "completed"))
  )
}

type PlanReference = {
  active: boolean
  terminal: boolean
  rootSessionId: string
  taskId: string
  reason: string
}

function addPlanReference(
  references: Map<string, PlanReference>,
  root: string,
  value: string | null | undefined,
  reference: PlanReference,
) {
  if (!value) return
  const resolved = path.resolve(value)
  if (!isPathInside(root, resolved) || resolved === path.resolve(root)) return
  const current = references.get(resolved)
  if (!current || (reference.active && !current.active)) references.set(resolved, reference)
}

function isPathInside(root: string, target: string) {
  const relative = path.relative(path.resolve(root), path.resolve(target))
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative))
}

function collectPlanReferences(planRoots: readonly string[], runtimeRoots: readonly string[]) {
  const references = new Map<string, PlanReference>()
  for (const workspaceRoot of planRoots) {
    const planRoot = path.join(path.resolve(workspaceRoot), ".jyycode", "plan")
    let sessions: fs.Dirent[]
    try {
      sessions = fs.readdirSync(planRoot, { withFileTypes: true })
    } catch {
      continue
    }
    for (const session of sessions) {
      if (!session.isDirectory()) continue
      const planPath = path.join(planRoot, session.name, "plan.json")
      let plan: PlanFile | null
      try {
        plan = readPlanFileSync(planPath)
      } catch {
        continue
      }
      if (!plan) continue
      for (const task of plan.steps.flatMap((step) => step.tasks)) {
        const active = planTaskIsActive(task)
        const reference: PlanReference = {
          active,
          terminal: !active,
          rootSessionId: session.name,
          taskId: task.id,
          reason: active ? "PLAN_ACTIVE" : "TERMINAL_PLAN_REFERENCE",
        }
        const values = [
          task.dispatch?.workspace?.directory,
          task.dispatch?.workspace?.baseline_directory,
          task.dispatch?.workspace?.baseline_manifest_path,
          task.merge?.journal_directory,
        ]
        for (const runtimeRoot of runtimeRoots) {
          for (const value of values) addPlanReference(references, runtimeRoot, value, reference)
        }
      }
    }
  }
  return references
}

async function measurePath(target: string, maxEntries: number) {
  let files = 0
  let dirs = 0
  let bytes = 0
  let entries = 0
  let truncated = false
  async function walk(current: string) {
    if (entries >= maxEntries) {
      truncated = true
      return
    }
    entries++
    let stat: fs.Stats
    try {
      stat = await fs.promises.lstat(current)
    } catch {
      return
    }
    if (stat.isDirectory()) {
      dirs++
      let children: fs.Dirent[]
      try {
        children = await fs.promises.readdir(current, { withFileTypes: true })
      } catch {
        return
      }
      for (const child of children) await walk(path.join(current, child.name))
      return
    }
    files++
    if (stat.isFile()) bytes += stat.size
  }
  await walk(target)
  return { files, dirs, bytes, truncated }
}

function sidecarPaths(directory: string) {
  const name = path.basename(directory)
  const root = path.dirname(directory)
  return {
    manifest: path.join(root, `${name}.manifest.json`),
    lease: path.join(root, `${name}.lease.json`),
    baseline: path.join(root, `${name}.baseline`),
    source: path.join(root, `${name}.source.json`),
  }
}

function readManifest(pathname: string) {
  if (!fs.existsSync(pathname)) return false
  try {
    const value = JSON.parse(fs.readFileSync(pathname, "utf8"))
    return Boolean(value && typeof value === "object" && !Array.isArray(value))
  } catch {
    return false
  }
}

async function inventoryItem(input: {
  root: string
  directory: string
  references: Map<string, PlanReference>
  sessionIds: Set<string>
  now: number
  orphanGraceMs: number
  maxEntries: number
  queue: Queue
}) {
  const directory = path.resolve(input.directory)
  let stat: fs.Stats
  try {
    stat = await fs.promises.lstat(directory)
  } catch {
    return undefined
  }
  if (!stat.isDirectory()) return undefined
  const sidecars = sidecarPaths(directory)
  let lease: WorkspaceLease | undefined
  try {
    lease = readWorkspaceLease(sidecars.lease)
  } catch {
    lease = undefined
  }
  const reference = input.references.get(directory)
  const manifestValid = readManifest(sidecars.manifest)
  const queueRecord = lease
    ? input.queue[queueKey(lease)]
    : Object.entries(input.queue).find(([key]) => key.endsWith(`\0${directory}`))?.[1]
  const usage = await measurePath(directory, input.maxEntries)
  for (const pathname of [sidecars.manifest, sidecars.lease, sidecars.source]) {
    try {
      const sidecarStat = await fs.promises.lstat(pathname)
      if (sidecarStat.isFile()) {
        usage.files++
        usage.bytes += sidecarStat.size
      }
    } catch {}
  }
  if (fs.existsSync(sidecars.baseline)) {
    const baselineUsage = await measurePath(sidecars.baseline, input.maxEntries)
    usage.files += baselineUsage.files
    usage.dirs += baselineUsage.dirs
    usage.bytes += baselineUsage.bytes
  }
  const expired = lease ? leaseIsExpired(lease, input.now) : false
  const withinGrace = lease ? input.now < Date.parse(lease.expires_at) + input.orphanGraceMs : false
  const recentUnleased =
    !lease &&
    Number.isFinite(stat.birthtimeMs) &&
    input.now >= stat.birthtimeMs &&
    input.now - stat.birthtimeMs < input.orphanGraceMs
  let category: WorkspaceInventoryCategory
  let reason: string
  let action: WorkspaceInventoryAction
  if (reference?.active || (lease !== undefined && !expired)) {
    category = "active"
    reason = reference?.reason ?? "ACTIVE_LEASE"
    action = "preserve"
  } else if (queueRecord?.state === "failed") {
    category = "cleanup_failed"
    reason = "CLEANUP_FAILED_RETRY"
    action = "retry_cleanup"
  } else if (reference?.terminal) {
    category = "terminal_reference"
    reason = reference.reason
    action = "quarantine"
  } else if (lease !== undefined && expired && manifestValid) {
    category = "orphan"
    reason = withinGrace
      ? "ORPHAN_GRACE"
      : input.sessionIds.has(lease.session_id)
        ? "EXPIRED_LEASE"
        : "EXPIRED_LEASE_NO_SESSION"
    action = withinGrace ? "preserve" : "quarantine"
  } else if (!manifestValid) {
    category = "unknown"
    reason = "MISSING_OR_INVALID_MANIFEST"
    action = "manual_review"
  } else if (isGeneratedDirectory(path.basename(directory))) {
    category = "orphan"
    reason = recentUnleased ? "ORPHAN_GRACE" : "UNREFERENCED_GENERATED_DIRECTORY"
    action = recentUnleased ? "preserve" : "quarantine"
  } else {
    category = "unknown"
    reason = "UNRECOGNIZED_LAYOUT"
    action = "manual_review"
  }
  const identity = {
    realpath: canonicalPath(directory),
    size: stat.size,
    mtime_ms: stat.mtimeMs,
  }
  const id = cleanupId({ root: input.root, directory, lease, stat })
  return {
    cleanup_id: id,
    category,
    recommended_action: action,
    source_root: path.resolve(input.root),
    directory,
    name: path.basename(directory),
    files: usage.files,
    dirs: usage.dirs,
    bytes: usage.bytes,
    ...(queueRecord?.attempts ? { cleanup_attempts: queueRecord.attempts } : {}),
    created_at: Number.isFinite(stat.birthtimeMs) ? new Date(stat.birthtimeMs).toISOString() : null,
    last_modified_at: Number.isFinite(stat.mtimeMs) ? new Date(stat.mtimeMs).toISOString() : null,
    root_session_id: lease?.root_session_id ?? reference?.rootSessionId ?? null,
    task_id: lease?.task_id ?? reference?.taskId ?? null,
    session_id: lease?.session_id ?? null,
    lease: lease
      ? {
          expires_at: lease.expires_at,
          heartbeat_at: lease.heartbeat_at,
          ...(lease.terminal_state ? { terminal_state: lease.terminal_state } : {}),
        }
      : null,
    reason,
    eligible:
      (category === "orphan" || category === "terminal_reference" || category === "cleanup_failed") &&
      !withinGrace &&
      !recentUnleased,
    identity,
  } satisfies WorkspaceInventoryItem
}

function emptyTelemetry(): WorkspaceInventoryTelemetry {
  return {
    gauges: { workspace_bytes: 0, workspace_dirs: 0, active_leases: 0, background_running: 0, pty_running: 0 },
    counters: {
      cleanup_attempts: 0,
      cleanup_failures: 0,
      cleanup_age_ms: 0,
      quota_rejection: 0,
      child_termination: 0,
      tool_timeout: 0,
      kill_failed: 0,
      mcp_idle_timeout: 0,
      mcp_total_timeout: 0,
    },
  }
}

export async function inspectWorkspaceStorage(input: WorkspaceInventoryOptions): Promise<WorkspaceInventoryResult> {
  const runtimeRoot = path.resolve(input.runtimeRoot)
  const legacyRoots = Array.from(
    new Set((input.legacyRoots ?? []).map((root) => path.resolve(root)).filter((root) => root !== runtimeRoot)),
  )
  const roots = [runtimeRoot, ...legacyRoots]
  fs.mkdirSync(runtimeRoot, { recursive: true })
  const now = inventoryNow(input)
  const maxEntries = input.maxEntries ?? WORKSPACE_RETENTION_DEFAULTS.inventoryMaxEntries
  const references = collectPlanReferences(input.planRoots ?? [], roots)
  const sessionIds = new Set(input.sessionIds ?? [])
  const categories = {
    active: [],
    cleanup_failed: [],
    orphan: [],
    terminal_reference: [],
    unknown: [],
  } as Record<WorkspaceInventoryCategory, WorkspaceInventoryItem[]>
  let scanned = 0
  let truncated = false
  for (const root of roots) {
    let entries: fs.Dirent[]
    try {
      entries = fs.readdirSync(root, { withFileTypes: true })
    } catch {
      continue
    }
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.name === ".quarantine" || entry.name.startsWith(".jyycode-")) continue
      if (scanned >= maxEntries) {
        truncated = true
        break
      }
      scanned++
      const item = await inventoryItem({
        root,
        directory: path.join(root, entry.name),
        references,
        sessionIds,
        now,
        orphanGraceMs: input.orphanGraceMs ?? WORKSPACE_RETENTION_DEFAULTS.orphanGraceMs,
        maxEntries,
        queue: loadQueue(root),
      })
      if (!item) continue
      categories[item.category].push(item)
      if (item.files + item.dirs >= maxEntries) truncated = true
    }
  }
  const items = Object.values(categories).flat()
  const telemetry = emptyTelemetry()
  for (const item of items) {
    telemetry.gauges.workspace_bytes += item.bytes
    telemetry.gauges.workspace_dirs += item.dirs
    if (item.category === "active" && item.lease) telemetry.gauges.active_leases++
    if (item.category === "cleanup_failed") {
      telemetry.counters.cleanup_attempts += item.cleanup_attempts ?? 0
      telemetry.counters.cleanup_failures++
      const updated = item.last_modified_at ? Date.parse(item.last_modified_at) : now
      telemetry.counters.cleanup_age_ms = Math.max(telemetry.counters.cleanup_age_ms, now - updated)
    }
  }
  const result: WorkspaceInventoryResult = {
    project: input.project ?? "global",
    runtime_root: runtimeRoot,
    legacy_roots: legacyRoots,
    index_path: workspaceInventoryIndexPath(runtimeRoot),
    generated_at: new Date(now).toISOString(),
    scanned,
    truncated,
    files: items.reduce((total, item) => total + item.files, 0),
    dirs: items.reduce((total, item) => total + item.dirs, 0),
    bytes: items.reduce((total, item) => total + item.bytes, 0),
    active_leases: telemetry.gauges.active_leases,
    categories,
    items,
    telemetry,
  }
  if (input.writeIndex !== false) {
    atomicWrite(result.index_path, {
      schema_version: 1,
      generated_at: result.generated_at,
      project: result.project,
      roots,
      items: items.map((item) => ({
        cleanup_id: item.cleanup_id,
        category: item.category,
        source_root: item.source_root,
        directory: item.directory,
        name: item.name,
        identity: item.identity,
        root_session_id: item.root_session_id,
        task_id: item.task_id,
        session_id: item.session_id,
      })),
    })
  }
  return result
}

function migrationSidecars(directory: string) {
  const paths = sidecarPaths(directory)
  return [paths.manifest, paths.lease, paths.baseline, paths.source].filter((pathname) => fs.existsSync(pathname))
}

async function quarantineItem(item: WorkspaceInventoryItem, now: number) {
  const sourceRoot = path.resolve(item.source_root)
  const directory = assertRuntimePath({
    runtimeRoot: sourceRoot,
    candidate: item.directory,
    label: "workspace migration directory",
  })
  const current = await fs.promises.lstat(directory)
  if (
    !current.isDirectory() ||
    canonicalPath(directory) !== item.identity.realpath ||
    current.size !== item.identity.size ||
    current.mtimeMs !== item.identity.mtime_ms
  ) {
    const error = new Error("workspace identity changed before quarantine")
    ;(error as Error & { code?: string }).code = "PATH_IDENTITY_MISMATCH"
    throw error
  }
  const quarantineRoot = path.join(sourceRoot, ".quarantine")
  await fs.promises.mkdir(quarantineRoot, { recursive: true })
  const target = path.join(quarantineRoot, `${item.name}-${item.cleanup_id}-${now}`)
  await fs.promises.rename(directory, target)
  for (const sidecar of migrationSidecars(item.directory)) {
    const suffix = path.basename(sidecar).slice(item.name.length)
    await fs.promises
      .rename(sidecar, path.join(quarantineRoot, `${item.name}-${item.cleanup_id}${suffix}`))
      .catch(() => {})
  }
  return target
}

export async function applyWorkspaceMigration(input: {
  project?: string
  runtimeRoot: string
  legacyRoots?: readonly string[]
  planRoots?: readonly string[]
  sessionIds?: readonly string[]
  cleanupIds: readonly string[]
  now?: number | (() => number)
  orphanGraceMs?: number
}): Promise<WorkspaceMigrationApplyResult> {
  const operationId = `workspace-migration-${Date.now().toString(36)}`
  const selected = new Set(input.cleanupIds.filter((id) => id.length > 0))
  const storedItems = loadInventoryIndex(input.runtimeRoot)
  const before = await inspectWorkspaceStorage({ ...input, writeIndex: true })
  const fresh = await inspectWorkspaceStorage({ ...input, writeIndex: false })
  const result: WorkspaceMigrationApplyResult = {
    operation_id: operationId,
    applied: [],
    quarantined: [],
    skipped: [],
    failures: [],
  }
  for (const cleanupId of selected) {
    const stored = storedItems?.find(
      (value): value is { cleanup_id: string; identity: WorkspaceInventoryItem["identity"] } =>
        Boolean(
          value &&
            typeof value === "object" &&
            "cleanup_id" in value &&
            value.cleanup_id === cleanupId &&
            "identity" in value,
        ),
    )
    const expected = stored ?? before.items.find((item) => item.cleanup_id === cleanupId)
    const item = fresh.items.find((candidate) => candidate.cleanup_id === cleanupId)
    if (!stored || !expected || !item) {
      result.skipped.push({ cleanup_id: cleanupId, reason: "NOT_IN_DRY_RUN_INVENTORY" })
      continue
    }
    if (item.category !== "orphan" && item.category !== "terminal_reference" && item.category !== "cleanup_failed") {
      result.skipped.push({ cleanup_id: cleanupId, reason: "CATEGORY_NOT_ELIGIBLE" })
      continue
    }
    if (JSON.stringify(item.identity) !== JSON.stringify(expected.identity) || !item.eligible) {
      result.skipped.push({ cleanup_id: cleanupId, reason: "IDENTITY_CHANGED_OR_GRACE_ACTIVE" })
      continue
    }
    try {
      const target = await quarantineItem(item, inventoryNow(input))
      result.applied.push(cleanupId)
      result.quarantined.push(target)
    } catch (error) {
      result.failures.push({
        cleanup_id: cleanupId,
        code:
          error && typeof error === "object" && "code" in error && typeof error.code === "string"
            ? error.code
            : "QUARANTINE_FAILED",
      })
    }
  }
  return result
}

export async function purgeExpiredWorkspaceQuarantine(input: {
  runtimeRoot: string
  now?: number
  quarantineMs?: number
  maxItems?: number
}) {
  const now = input.now ?? Date.now()
  const root = path.resolve(input.runtimeRoot)
  const quarantineRoot = path.join(root, ".quarantine")
  if (!fs.existsSync(quarantineRoot)) return { removed: [] as string[], failures: [] as string[] }
  const removed: string[] = []
  const failures: string[] = []
  for (const entry of fs.readdirSync(quarantineRoot, { withFileTypes: true }).slice(0, input.maxItems ?? 20)) {
    const target = path.join(quarantineRoot, entry.name)
    try {
      const stat = fs.statSync(target)
      if (now - stat.mtimeMs < (input.quarantineMs ?? WORKSPACE_RETENTION_DEFAULTS.quarantineMs)) continue
      await fs.promises.rm(target, { recursive: true, force: true })
      removed.push(target)
    } catch {
      failures.push(target)
    }
  }
  return { removed, failures }
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
    if (!input.dryRun) {
      await purgeExpiredWorkspaceQuarantine({
        runtimeRoot: this.runtimeRoot,
        now: this.now(),
        quarantineMs: this.retention.quarantineMs,
        maxItems: this.maxItemsPerScan,
      })
    }
    return result
  }

  start() {
    if (this.interval) return this
    // The first process using a runtime root only inventories it. A later
    // process may run the normal lease/plan confirmation sweep. This gives a
    // newly upgraded installation a durable, reviewable baseline before any
    // quarantine or cleanup operation is attempted.
    const indexPath = workspaceInventoryIndexPath(this.runtimeRoot)
    if (!fs.existsSync(indexPath)) {
      void inspectWorkspaceStorage({ runtimeRoot: this.runtimeRoot, writeIndex: true }).catch(() => {})
    } else {
      void this.scan({ dryRun: true })
    }
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
