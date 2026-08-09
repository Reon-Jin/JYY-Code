import { Database } from "bun:sqlite"
import { mkdir, readdir, stat } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { Effect } from "effect"
import { CliError, effectCmd } from "../../effect-cmd"
import { cmd } from "../cmd"

export type StorageEntryKind =
  | "active-channel-db"
  | "inactive-channel-db"
  | "recognized-migration-backup"
  | "unknown-backup"
  | "other"

export type StorageDatabaseReport = {
  readonly path: string
  readonly kind: StorageEntryKind
  readonly bytes: number
  readonly sessionCount?: number
  readonly messageCount?: number
  readonly partCount?: number
  readonly partJsonBytes?: number
  readonly toolJsonBytes?: number
  readonly base64PartBytes?: number
  readonly readable: boolean
  readonly error?: string
}

export type StorageFileReport = {
  readonly path: string
  readonly bytes: number
}

export type StorageAuditReport = {
  readonly root: string
  readonly generatedAt: string
  readonly databases: readonly StorageDatabaseReport[]
  readonly logs: {
    readonly bytes: number
    readonly files: number
    readonly entries: readonly StorageFileReport[]
  }
  readonly backups: readonly StorageFileReport[]
  readonly candidates: readonly StorageFileReport[]
}

export type StorageAuditOptions = {
  readonly root?: string
  readonly database?: string
  readonly readonly?: boolean
  readonly queryDeadlineMs?: number
}

export class StorageAuditError extends Error {
  readonly code = "STORAGE_AUDIT_FAILED"
}

function defaultRoot() {
  if (process.env.JYYCODE_DATA_DIR) return path.resolve(process.env.JYYCODE_DATA_DIR)
  if (process.platform === "win32")
    return path.join(process.env.LOCALAPPDATA ?? path.join(os.homedir(), "AppData", "Local"), "jyycode")
  return path.join(process.env.XDG_DATA_HOME ?? path.join(os.homedir(), ".local", "share"), "jyycode")
}

function isDatabaseName(name: string) {
  return /(?:^jyycode(?:-[a-zA-Z0-9._-]+)?\.db(?:\.backup[-.]\w+)?$|\.db(?:\.wal|\.shm)?$)/i.test(name)
}

function classify(name: string, relative: string): StorageEntryKind {
  if (name === "jyycode.db") return "active-channel-db"
  if (/^jyycode-[a-zA-Z0-9._-]+\.db$/i.test(name)) return "inactive-channel-db"
  if (/(?:backup|backups)[\\/]/i.test(relative) && /(?:backup[-.]\d{6,}|epoch\d+)/i.test(name)) {
    return "recognized-migration-backup"
  }
  if (/\.db\.backup[-.]\d{6,}$/i.test(name)) {
    return "recognized-migration-backup"
  }
  if (/backup/i.test(name) || /(?:backup|backups)[\\/]/i.test(relative)) return "unknown-backup"
  return "other"
}

async function filesUnder(root: string, relative = ""): Promise<StorageFileReport[]> {
  const dir = path.join(root, relative)
  const entries = await readdir(dir, { withFileTypes: true }).catch(() => [])
  const files: StorageFileReport[] = []
  for (const entry of entries) {
    const next = path.join(relative, entry.name)
    const full = path.join(root, next)
    if (entry.isDirectory()) {
      files.push(...(await filesUnder(root, next)))
      continue
    }
    if (!entry.isFile()) continue
    const info = await stat(full).catch(() => undefined)
    if (info) files.push({ path: full, bytes: info.size })
  }
  return files
}

function queryNumber(db: Database, sql: string, deadline: number): number {
  if (Date.now() > deadline) throw new StorageAuditError("storage audit query deadline exceeded")
  const row = db.query(sql).get() as Record<string, unknown> | null
  if (!row) return 0
  const value = Object.values(row)[0]
  return typeof value === "number" ? value : Number(value ?? 0)
}

function inspectDatabase(file: StorageFileReport, kind: StorageEntryKind, deadlineMs: number): StorageDatabaseReport {
  const report: StorageDatabaseReport = { path: file.path, kind, bytes: file.bytes, readable: false }
  const deadline = Date.now() + deadlineMs
  let db: Database | undefined
  try {
    db = new Database(file.path, { readonly: true, create: false })
    db.exec("PRAGMA busy_timeout = 5000")
    db.exec("PRAGMA query_only = ON")
    const sessionCount = queryNumber(db, "SELECT COUNT(*) FROM session", deadline)
    const messageCount = queryNumber(db, "SELECT COUNT(*) FROM message", deadline)
    const partCount = queryNumber(db, "SELECT COUNT(*) FROM part", deadline)
    const partJsonBytes = queryNumber(db, "SELECT COALESCE(SUM(length(data)), 0) FROM part", deadline)
    const toolJsonBytes = queryNumber(
      db,
      `SELECT COALESCE(SUM(length(data)), 0) FROM part WHERE data LIKE '%"type":"tool"%'`,
      deadline,
    )
    const base64PartBytes = queryNumber(
      db,
      `SELECT COALESCE(SUM(length(data)), 0) FROM part WHERE data LIKE '%base64,%'`,
      deadline,
    )
    return {
      ...report,
      sessionCount,
      messageCount,
      partCount,
      partJsonBytes,
      toolJsonBytes,
      base64PartBytes,
      readable: true,
    }
  } catch (error) {
    return { ...report, error: error instanceof Error ? error.message : String(error) }
  } finally {
    db?.close(false)
  }
}

export async function auditStorage(options: StorageAuditOptions = {}): Promise<StorageAuditReport> {
  if (options.database && options.readonly !== true) {
    throw new StorageAuditError("--database requires --readonly; refusing a potentially writable audit target")
  }
  const root = path.resolve(options.root ?? defaultRoot())
  const allFiles = options.database
    ? [
        {
          path: path.resolve(options.database),
          bytes: (await stat(path.resolve(options.database))).size,
        },
      ]
    : await filesUnder(root)
  const deadlineMs = options.queryDeadlineMs ?? 5000
  const databases = allFiles
    .filter((file) => isDatabaseName(path.basename(file.path)))
    .map((file) => {
      const relative = path.relative(root, file.path)
      return inspectDatabase(file, classify(path.basename(file.path), relative), deadlineMs)
    })
  const logs = allFiles.filter((file) => path.relative(root, file.path).split(path.sep)[0]?.toLowerCase() === "log")
  const backups = allFiles.filter((file) => /backup/i.test(path.relative(root, file.path)))
  const candidates = allFiles.filter((file) => {
    const relative = path.relative(root, file.path)
    return /backup|\.db(?:\.wal|\.shm)?$/i.test(relative) || relative.split(path.sep)[0]?.toLowerCase() === "log"
  })
  return {
    root,
    generatedAt: new Date().toISOString(),
    databases,
    logs: {
      bytes: logs.reduce((total, item) => total + item.bytes, 0),
      files: logs.length,
      entries: logs,
    },
    backups,
    candidates,
  }
}

export async function createAuditFixtureRoot(root: string) {
  await mkdir(path.join(root, "log"), { recursive: true })
}

const AuditCommand = effectCmd({
  command: "audit",
  describe: "inspect session storage without modifying it",
  instance: false,
  builder: (yargs) =>
    yargs
      .option("database", { type: "string", description: "database path to inspect" })
      .option("readonly", { type: "boolean", default: false, description: "require an explicit read-only database open" })
      .option("json", { type: "boolean", default: false, description: "write machine-readable JSON" })
      .option("root", { type: "string", description: "storage root override for diagnostics/tests" }),
  handler: Effect.fn("Cli.debug.storage.audit")(function* (args) {
    const report = yield* Effect.tryPromise({
      try: () => auditStorage({ root: args.root, database: args.database, readonly: args.readonly }),
      catch: (error) => new CliError({ message: error instanceof Error ? error.message : String(error) }),
    })
    process.stdout.write(args.json ? `${JSON.stringify(report)}\n` : `${JSON.stringify(report, null, 2)}\n`)
  }),
})

export const StorageCommand = cmd({
  command: "storage",
  describe: "session storage diagnostics",
  builder: (yargs) => yargs.command(AuditCommand).demandCommand(),
  async handler() {},
})
