import { Global } from "@jyycode-ai/core/global"
import { statfs } from "node:fs/promises"
import { readdir, stat } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { auditStorage, type StorageAuditReport } from "@/cli/cmd/debug/storage-audit"

export const RETENTION_DEFAULTS = {
  terminalChildTtlMs: 30 * 24 * 60 * 60 * 1000,
  warningRootBytes: 1 * 1024 * 1024 * 1024,
  warningSessionBytes: 100 * 1024 * 1024,
  warningFreeRatio: 0.05,
  warningFreeBytes: 1 * 1024 * 1024 * 1024,
} as const

export type RetentionLifecycle =
  | "active"
  | "terminal"
  | "leased"
  | "waiting_permission"
  | "waiting_question"
  | "unknown"

export type RetentionArtifact = "session" | "database" | "backup" | "workspace" | "blob" | "other"

export type RetentionDecision = {
  readonly action: "preserve" | "prune_payload"
  readonly reason: string
  readonly automatic: boolean
}

export type RetentionDecisionInput = {
  readonly lifecycle?: RetentionLifecycle
  readonly root?: boolean
  readonly artifact?: RetentionArtifact
  readonly updatedAt?: number
  readonly now?: number
  readonly terminalChildTtlMs?: number
}

/**
 * Decide what maintenance is allowed to do without relying on transient UI
 * state. There is deliberately no delete action: session deletion remains an
 * explicit user operation, while old terminal children may lose large tool
 * payloads after their retention window.
 */
export function retentionDecision(input: RetentionDecisionInput): RetentionDecision {
  if (input.root || input.artifact === "database" || input.artifact === "backup") {
    return { action: "preserve", reason: input.root ? "root-session" : `preserve-${input.artifact}`, automatic: false }
  }

  const lifecycle = input.lifecycle ?? "unknown"
  if (lifecycle === "unknown") return { action: "preserve", reason: "unknown-lifecycle", automatic: false }
  if (lifecycle === "active") return { action: "preserve", reason: "active-session", automatic: false }
  if (lifecycle === "leased") return { action: "preserve", reason: "leased-session", automatic: false }
  if (lifecycle === "waiting_permission")
    return { action: "preserve", reason: "waiting-permission", automatic: false }
  if (lifecycle === "waiting_question") return { action: "preserve", reason: "waiting-question", automatic: false }

  const now = input.now ?? Date.now()
  const updatedAt = input.updatedAt ?? now
  const ttl = Math.max(0, input.terminalChildTtlMs ?? RETENTION_DEFAULTS.terminalChildTtlMs)
  if (now - updatedAt >= ttl) return { action: "prune_payload", reason: "terminal-child-expired", automatic: true }
  return { action: "preserve", reason: "terminal-child-within-retention", automatic: false }
}

export function parseDuration(value: string): number {
  const match = value.trim().toLowerCase().match(/^(\d+(?:\.\d+)?)(ms|s|m|h|d|w)$/)
  if (!match) throw new Error(`invalid duration: ${value}; use a value such as 30d, 12h, or 15m`)
  const amount = Number(match[1])
  const unit = match[2]
  const multiplier = unit === "ms" ? 1 : unit === "s" ? 1000 : unit === "m" ? 60_000 : unit === "h" ? 3_600_000 : unit === "d" ? 86_400_000 : 604_800_000
  const result = amount * multiplier
  if (!Number.isFinite(result) || result <= 0) throw new Error(`invalid duration: ${value}`)
  return Math.floor(result)
}

export type StorageCount = {
  readonly count: number
  readonly bytes: number
}

export type StorageInspection = {
  readonly root: string
  readonly generatedAt: string
  readonly total: StorageCount
  readonly sessions: StorageCount
  readonly tools: StorageCount
  readonly blobs: StorageCount
  readonly logs: StorageCount
  readonly channelDatabases: StorageCount
  readonly backups: StorageCount
  readonly workspaces: StorageCount
  readonly toolOutput: StorageCount
  readonly databases: readonly StorageAuditReport["databases"][number][]
  readonly warnings: readonly string[]
  readonly hardStop: {
    readonly lowDisk: boolean
    readonly blockNewLargeBlob: boolean
    readonly freeBytes?: number
    readonly thresholdBytes?: number
    readonly allowedDuringHardStop: readonly ["text-session", "export", "delete", "recovery"]
  }
  readonly retention: {
    readonly automaticSessionDeletion: false
    readonly reasons: readonly string[]
  }
}

type FileEntry = { readonly path: string; readonly bytes: number }

async function filesUnder(root: string, relative = ""): Promise<FileEntry[]> {
  const directory = path.join(root, relative)
  const entries = await readdir(directory, { withFileTypes: true }).catch(() => [])
  const result: FileEntry[] = []
  for (const entry of entries) {
    const next = path.join(relative, entry.name)
    const full = path.join(root, next)
    if (entry.isDirectory()) {
      result.push(...(await filesUnder(root, next)))
      continue
    }
    if (!entry.isFile()) continue
    const info = await stat(full).catch(() => undefined)
    if (info) result.push({ path: full, bytes: info.size })
  }
  return result
}

function total(entries: readonly FileEntry[]): StorageCount {
  return { count: entries.length, bytes: entries.reduce((sum, entry) => sum + entry.bytes, 0) }
}

function isCanonicalBlob(entry: FileEntry, root: string) {
  const relative = path.relative(root, entry.path).split(path.sep)
  return relative[0] === "blob" && relative[1] === "sha256" && /^[a-f0-9]{2}$/.test(relative[2] ?? "") && /^[a-f0-9]{64}$/.test(relative[3] ?? "")
}

function aggregateDatabaseBytes(report: StorageAuditReport) {
  const readable = report.databases.filter((database) => database.readable)
  return {
    sessions: {
      count: readable.reduce((sum, database) => sum + (database.sessionCount ?? 0), 0),
      bytes: readable.reduce((sum, database) => sum + (database.partJsonBytes ?? 0), 0),
    },
    tools: {
      count: readable.reduce((sum, database) => sum + (database.toolJsonBytes ? 1 : 0), 0),
      bytes: readable.reduce((sum, database) => sum + (database.toolJsonBytes ?? 0), 0),
    },
  }
}

export async function inspectStorage(root = Global.Path.data): Promise<StorageInspection> {
  const resolvedRoot = path.resolve(root)
  const [files, audit] = await Promise.all([filesUnder(resolvedRoot), auditStorage({ root: resolvedRoot })])
  const blobs = files.filter((entry) => isCanonicalBlob(entry, resolvedRoot))
  const logs = files.filter((entry) => path.relative(resolvedRoot, entry.path).split(path.sep)[0]?.toLowerCase() === "log")
  const backups = files.filter((entry) => /backup/i.test(path.relative(resolvedRoot, entry.path)))
  const workspaces = files.filter((entry) => /^(?:plan-)?workspaces?$/i.test(path.relative(resolvedRoot, entry.path).split(path.sep)[0] ?? ""))
  const toolOutput = files.filter((entry) => /(?:tool[-_]?output|truncat)/i.test(path.relative(resolvedRoot, entry.path)))
  const channels = audit.databases.filter((database) => database.kind === "active-channel-db" || database.kind === "inactive-channel-db")
  const databaseStats = aggregateDatabaseBytes(audit)
  const disk = await statfs(resolvedRoot).catch(() => undefined)
  const freeBytes = disk ? Number(disk.bavail) * Number(disk.bsize) : undefined
  const totalDiskBytes = disk ? Number(disk.blocks) * Number(disk.bsize) : undefined
  const freeThreshold = totalDiskBytes === undefined ? undefined : Math.max(RETENTION_DEFAULTS.warningFreeBytes, totalDiskBytes * RETENTION_DEFAULTS.warningFreeRatio)
  const warnings: string[] = []
  const rootBytes = files.reduce((sum, entry) => sum + entry.bytes, 0)
  if (rootBytes > RETENTION_DEFAULTS.warningRootBytes) warnings.push("data-root-over-1GiB")
  if (audit.databases.some((database) => database.bytes > RETENTION_DEFAULTS.warningSessionBytes)) warnings.push("single-session-storage-over-100MiB")
  const lowDisk = freeBytes !== undefined && freeThreshold !== undefined && freeBytes < freeThreshold
  if (lowDisk) warnings.push("low-free-disk")
  if (audit.backups.length > 0) warnings.push("backups-preserved-unless-recognized")
  if (audit.databases.some((entry) => entry.kind === "unknown-backup")) warnings.push("unknown-database-preserved")

  return {
    root: resolvedRoot,
    generatedAt: new Date().toISOString(),
    total: total(files),
    sessions: databaseStats.sessions,
    tools: databaseStats.tools,
    blobs: total(blobs),
    logs: total(logs),
    channelDatabases: { count: channels.length, bytes: channels.reduce((sum, database) => sum + database.bytes, 0) },
    backups: total(backups),
    workspaces: total(workspaces),
    toolOutput: total(toolOutput),
    databases: audit.databases,
    warnings,
    hardStop: {
      lowDisk,
      blockNewLargeBlob: lowDisk,
      ...(freeBytes === undefined ? {} : { freeBytes }),
      ...(freeThreshold === undefined ? {} : { thresholdBytes: freeThreshold }),
      allowedDuringHardStop: ["text-session", "export", "delete", "recovery"],
    },
    retention: {
      automaticSessionDeletion: false,
      reasons: ["root-sessions-preserved", "active-and-waiting-sessions-preserved", "unknown-databases-and-backups-reported-only"],
    },
  }
}

export type CleanupPlan = {
  readonly dryRun: boolean
  readonly olderThanMs: number
  readonly inspection: StorageInspection
  readonly decisions: readonly RetentionDecision[]
}

export async function planCleanup(options: { readonly root?: string; readonly olderThanMs?: number; readonly dryRun?: boolean } = {}): Promise<CleanupPlan> {
  const olderThanMs = options.olderThanMs ?? RETENTION_DEFAULTS.terminalChildTtlMs
  const inspection = await inspectStorage(options.root)
  return {
    dryRun: options.dryRun !== false,
    olderThanMs,
    inspection,
    decisions: [
      retentionDecision({ root: true, artifact: "session" }),
      retentionDecision({ lifecycle: "unknown", artifact: "database" }),
      retentionDecision({ lifecycle: "terminal", updatedAt: Date.now() - olderThanMs, terminalChildTtlMs: olderThanMs }),
    ],
  }
}

export function defaultStorageRoot() {
  if (process.env.JYYCODE_DATA_DIR) return path.resolve(process.env.JYYCODE_DATA_DIR)
  if (process.platform === "win32") return path.join(process.env.LOCALAPPDATA ?? path.join(os.homedir(), "AppData", "Local"), "jyycode")
  return path.join(process.env.XDG_DATA_HOME ?? path.join(os.homedir(), ".local", "share"), "jyycode")
}
