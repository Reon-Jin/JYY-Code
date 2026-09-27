import { Effect } from "effect"
import { eq, inArray } from "drizzle-orm"
import { readdir, rm, stat } from "node:fs/promises"
import path from "node:path"
import { Database, getPath } from "@/storage/db"
import { Database as SQLiteDatabase } from "bun:sqlite"
import { BlobRefTable, BlobTable } from "./blob.sql"
import { BLOB_GRACE_MS } from "./blob"
import { blobLeasePath, blobPath, blobRoot, blobTempRoot, isBlobDigest } from "./blob-path"
import { Global } from "@jyycode-ai/core/global"

export type BlobGCOptions = {
  readonly now?: number
  readonly graceMs?: number
  readonly dryRun?: boolean
  /** Limit maintenance to these content hashes, without scanning the blob tree. */
  readonly onlyDigests?: readonly string[]
}

export type BlobGCResult = {
  readonly scanned: number
  readonly referenced: number
  readonly marked: number
  readonly eligible: number
  readonly deleted: number
  readonly skippedLease: number
  readonly bytesEligible: number
  readonly bytesDeleted: number
  readonly orphanFiles: number
  readonly orphanBytes: number
  readonly tempFiles: number
  readonly tempBytes: number
}

type MutableResult = {
  -readonly [K in keyof BlobGCResult]: BlobGCResult[K]
}

async function exists(file: string) {
  return stat(file).then(
    () => true,
    () => false,
  )
}

async function fileSize(file: string) {
  return stat(file).then(
    (item) => item.size,
    () => 0,
  )
}

async function canonicalFiles(root: string) {
  const result: string[] = []
  const base = blobRoot(root)
  for (const shard of await readdir(base, { withFileTypes: true }).catch(() => [])) {
    if (!shard.isDirectory() || !/^[a-f0-9]{2}$/.test(shard.name)) continue
    for (const entry of await readdir(path.join(base, shard.name), { withFileTypes: true }).catch(() => [])) {
      if (entry.isFile() && isBlobDigest(entry.name) && entry.name.slice(0, 2) === shard.name)
        result.push(path.join(base, shard.name, entry.name))
    }
  }
  return result
}

async function temporaryFiles(root: string) {
  const base = blobTempRoot(root)
  return (await readdir(base, { withFileTypes: true }).catch(() => []))
    .filter((entry) => entry.isFile() && !entry.name.endsWith(".lease"))
    .map((entry) => path.join(base, entry.name))
}

/**
 * Blob files are shared by installation channels, while each channel can have
 * its own SQLite database. Keep read-only connections for one GC pass so
 * targeted rechecks use indexed lookups instead of rereading every reference.
 */
async function openSharedReferenceReader(root: string) {
  const active = getPath()
  if (root === path.resolve(Global.Path.data) && active !== ":memory:") {
    const relative = path.relative(root, active)
    if (relative.startsWith("..") || path.isAbsolute(relative)) {
      throw new Error("Blob GC cannot verify an active database outside the shared blob root")
    }
  }
  const entries = await readdir(root, { withFileTypes: true }).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return []
    throw error
  })
  const sources: Array<{ name: string; db: SQLiteDatabase; references: boolean }> = []
  const close = () => {
    for (const source of sources) source.db.close(false)
  }
  try {
    for (const entry of entries) {
      // A backed-up SQLite database can have its own WAL/SHM sidecars. They
      // are not databases and must not make all maintenance fail closed.
      if (/(?:-wal|-shm|-journal)$/i.test(entry.name)) continue
      if (!/\.db(?:\.backup[-.][\w.-]+)?$/i.test(entry.name)) continue
      if (!entry.isFile()) throw new Error(`Blob GC cannot verify database entry ${entry.name}`)
      const file = path.join(root, entry.name)
      let db: SQLiteDatabase | undefined
      try {
        db = new SQLiteDatabase(file, { readonly: true, create: false })
        db.exec("PRAGMA busy_timeout = 1000")
        db.exec("PRAGMA query_only = ON")
        const tables = db
          .query("SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('blob_ref', 'part')")
          .all() as Array<{ name: string }>
        const references = tables.some((table) => table.name === "blob_ref")
        if (!references && tables.some((table) => table.name === "part")) {
          // A database predating blob_ref can still contain blob URLs.
          const legacy = db.query("SELECT 1 FROM part WHERE CAST(data AS TEXT) LIKE '%blob:sha256:%' LIMIT 1").get()
          if (legacy) throw new Error("database has blob URLs without a reference table")
        }
        sources.push({ name: entry.name, db, references })
      } catch (error) {
        db?.close(false)
        throw new Error(
          `Blob GC cannot verify ${entry.name}: ${error instanceof Error ? error.message : String(error)}`,
          { cause: error },
        )
      }
    }
  } catch (error) {
    close()
    throw error
  }
  return {
    close,
    all(): Set<string> {
      const digests = new Set<string>()
      for (const source of sources) {
        if (!source.references) continue
        try {
          for (const row of source.db.query("SELECT DISTINCT digest FROM blob_ref").all() as Array<{
            digest: string
          }>) {
            if (!isBlobDigest(row.digest)) throw new Error("invalid blob reference digest")
            digests.add(row.digest)
          }
        } catch (error) {
          throw new Error(
            `Blob GC cannot verify ${source.name}: ${error instanceof Error ? error.message : String(error)}`,
            { cause: error },
          )
        }
      }
      return digests
    },
    has(digest: string): boolean {
      for (const source of sources) {
        if (!source.references) continue
        try {
          // blob_ref_digest_idx serves this lookup in current databases.
          if (source.db.query("SELECT 1 FROM blob_ref WHERE digest = ? LIMIT 1").get(digest)) return true
        } catch (error) {
          throw new Error(
            `Blob GC cannot verify ${source.name}: ${error instanceof Error ? error.message : String(error)}`,
            { cause: error },
          )
        }
      }
      return false
    },
  }
}

export class BlobGarbageCollector {
  readonly root: string

  constructor(root = Global.Path.data) {
    this.root = path.resolve(root)
  }

  run(options: BlobGCOptions = {}): Effect.Effect<BlobGCResult> {
    const now = options.now ?? Date.now()
    const graceMs = options.graceMs ?? BLOB_GRACE_MS
    if (!Number.isSafeInteger(now) || now < 0 || !Number.isSafeInteger(graceMs) || graceMs < 0) {
      throw new Error("Blob GC requires a non-negative time and grace period")
    }
    const cutoff = now - graceMs
    const dryRun = options.dryRun === true
    const onlyDigests = options.onlyDigests === undefined ? undefined : [...new Set(options.onlyDigests)]
    if (onlyDigests?.some((digest) => !isBlobDigest(digest))) {
      throw new Error("Blob GC onlyDigests must contain canonical SHA-256 digests")
    }
    const result: MutableResult = {
      scanned: 0,
      referenced: 0,
      marked: 0,
      eligible: 0,
      deleted: 0,
      skippedLease: 0,
      bytesEligible: 0,
      bytesDeleted: 0,
      orphanFiles: 0,
      orphanBytes: 0,
      tempFiles: 0,
      tempBytes: 0,
    }

    const root = this.root
    return Effect.acquireUseRelease(
      Effect.promise(() => openSharedReferenceReader(root)),
      (reader) =>
        Effect.gen(function* () {
          // Complete cross-channel verification before marking or removing anything.
          const protectedDigests = onlyDigests
            ? new Set(onlyDigests.filter((digest) => reader.has(digest)))
            : reader.all()
          const rows: (typeof BlobTable.$inferSelect)[] = []
          if (onlyDigests) {
            // Bound SQLite variables and avoid reading unrelated blob metadata.
            for (let index = 0; index < onlyDigests.length; index += 200) {
              const batch = onlyDigests.slice(index, index + 200)
              rows.push(
                ...(yield* Database.query((db) =>
                  db.select().from(BlobTable).where(inArray(BlobTable.digest, batch)).all(),
                )),
              )
            }
          } else {
            rows.push(...(yield* Database.query((db) => db.select().from(BlobTable).all())))
          }
          result.scanned = rows.length
          const known = new Set(rows.map((row) => row.digest))
          for (const row of rows) {
            if (protectedDigests.has(row.digest)) {
              result.referenced++
              continue
            }
            const references = yield* Database.query((db) =>
              db
                .select({ digest: BlobRefTable.digest })
                .from(BlobRefTable)
                .where(eq(BlobRefTable.digest, row.digest))
                .all(),
            )
            if (references.length > 0) {
              result.referenced++
              continue
            }
            // Request envelopes are persisted as JSON blobs without blob_ref.
            // Their creation/last verification time is the only retention
            // clock, so a 24-hour-old envelope can be reclaimed on this pass.
            // Other blobs may have lost their final reference recently; give
            // those a full grace period from the first unreferenced scan.
            const removedAt = row.last_ref_removed_at ??
              (row.mime === "application/json" ? Math.max(row.created_at, row.verified_at) : now)
            if (row.last_ref_removed_at == null) {
              if (!dryRun)
                yield* Database.withTransaction((db) =>
                  db.update(BlobTable).set({ last_ref_removed_at: removedAt }).where(eq(BlobTable.digest, row.digest)).run(),
                )
              result.marked++
              if (row.mime !== "application/json") continue
            }
            if (removedAt > cutoff) continue
            if (yield* Effect.promise(() => exists(blobLeasePath(row.digest, root)))) {
              result.skippedLease++
              continue
            }
            // A newly attached reference in another installation channel may
            // appear after the first scan. Recheck before targeted fast cleanup.
            // Cross-database writes cannot be locked atomically here; callers
            // should prefer a short grace period for recently detached images.
            if (onlyDigests && reader.has(row.digest)) {
              result.referenced++
              continue
            }
            result.eligible++
            result.bytesEligible += row.size
            if (dryRun) continue

            const file = blobPath(row.digest, root)
            const removed = yield* Database.withTransaction((db) =>
              Effect.gen(function* () {
                const stillReferenced = yield* db
                  .select({ digest: BlobRefTable.digest })
                  .from(BlobRefTable)
                  .where(eq(BlobRefTable.digest, row.digest))
                  .all()
                if (stillReferenced.length > 0) return false
                yield* Effect.promise(() => rm(file, { force: true }))
                yield* db.delete(BlobTable).where(eq(BlobTable.digest, row.digest)).run()
                return true
              }),
            )
            if (removed) {
              result.deleted++
              result.bytesDeleted += row.size
            }
          }

          const orphanCandidates = onlyDigests
            ? onlyDigests.filter((digest) => !known.has(digest)).map((digest) => blobPath(digest, root))
            : yield* Effect.promise(() => canonicalFiles(root))
          for (const file of orphanCandidates) {
            const digest = path.basename(file)
            if (known.has(digest) || protectedDigests.has(digest)) continue
            const info = yield* Effect.promise(() => stat(file).catch(() => undefined))
            if (!info) continue
            const mtime = info.mtimeMs
            const size = info.size
            if (mtime > cutoff || (yield* Effect.promise(() => exists(blobLeasePath(digest, root))))) continue
            if (onlyDigests && reader.has(digest)) continue
            result.orphanFiles++
            result.orphanBytes += size
            if (!dryRun) yield* Effect.promise(() => rm(file, { force: true }))
          }

          if (!onlyDigests) {
            for (const file of yield* Effect.promise(() => temporaryFiles(root))) {
              const mtime = (yield* Effect.promise(() => stat(file))).mtimeMs
              const size = yield* Effect.promise(() => fileSize(file))
              if (mtime > cutoff) continue
              result.tempFiles++
              result.tempBytes += size
              if (!dryRun) yield* Effect.promise(() => rm(file, { force: true }))
            }
          }
          return result
        }),
      (reader) => Effect.sync(() => reader.close()),
    )
  }

  runNow(options: BlobGCOptions = {}) {
    return Effect.runPromise(this.run(options))
  }
}

export const run = (options: BlobGCOptions & { root?: string } = {}) =>
  new BlobGarbageCollector(options.root).run(options)

export const BLOB_GC_STARTUP_DELAY_MS = 60_000
export const BLOB_GC_INTERVAL_MS = 60 * 60 * 1000

export function startBlobGCScheduler(
  options: {
    readonly startupDelayMs?: number
    readonly intervalMs?: number
    readonly run?: () => Promise<unknown>
    readonly onError?: (error: unknown) => void
  } = {},
) {
  const startupDelayMs = options.startupDelayMs ?? BLOB_GC_STARTUP_DELAY_MS
  const intervalMs = options.intervalMs ?? BLOB_GC_INTERVAL_MS
  if (
    !Number.isSafeInteger(startupDelayMs) ||
    startupDelayMs < 0 ||
    !Number.isSafeInteger(intervalMs) ||
    intervalMs < 1
  )
    throw new Error("Invalid blob GC schedule")
  const runOnce = options.run ?? (() => new BlobGarbageCollector().runNow())
  let stopped = false
  let timer: ReturnType<typeof setTimeout> | undefined
  let current: Promise<unknown> | undefined
  const schedule = (delay: number) => {
    timer = setTimeout(() => {
      if (stopped) return
      current = Promise.resolve()
        .then(runOnce)
        .catch((error) => {
          try {
            options.onError?.(error)
          } catch {
            /* maintenance must not stop the server */
          }
        })
        .finally(() => {
          current = undefined
          if (!stopped) schedule(intervalMs)
        })
    }, delay)
    timer.unref?.()
  }
  schedule(startupDelayMs)
  return {
    async stop() {
      stopped = true
      if (timer) clearTimeout(timer)
      await current
    },
  }
}

let sharedScheduler: ReturnType<typeof startBlobGCScheduler> | undefined
let schedulerUsers = 0

/** One low-priority maintenance timer per process, shared by all listeners. */
export function acquireBlobGCScheduler(onError?: (error: unknown) => void) {
  schedulerUsers++
  sharedScheduler ??= startBlobGCScheduler({ onError })
  let released = false
  return async () => {
    if (released) return
    released = true
    schedulerUsers--
    if (schedulerUsers !== 0) return
    const scheduler = sharedScheduler
    sharedScheduler = undefined
    await scheduler?.stop()
  }
}
