import { Effect } from "effect"
import { eq } from "drizzle-orm"
import { readdir, rm, stat } from "node:fs/promises"
import path from "node:path"
import { Database } from "@/storage/db"
import { BlobRefTable, BlobTable } from "./blob.sql"
import { BLOB_GRACE_MS } from "./blob"
import { blobLeasePath, blobPath, blobRoot, blobTempRoot, isBlobDigest } from "./blob-path"
import { Global } from "@jyycode-ai/core/global"

export type BlobGCOptions = {
  readonly now?: number
  readonly graceMs?: number
  readonly dryRun?: boolean
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
  return stat(file).then(() => true, () => false)
}

async function fileSize(file: string) {
  return stat(file).then((item) => item.size, () => 0)
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

export class BlobGarbageCollector {
  readonly root: string

  constructor(root = Global.Path.data) {
    this.root = path.resolve(root)
  }

  run(options: BlobGCOptions = {}): Effect.Effect<BlobGCResult> {
    const now = options.now ?? Date.now()
    const graceMs = options.graceMs ?? BLOB_GRACE_MS
    const cutoff = now - graceMs
    const dryRun = options.dryRun === true
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
    return Effect.gen(function* () {
      const rows = yield* Database.query((db) => db.select().from(BlobTable).all())
      result.scanned = rows.length
      const known = new Set(rows.map((row) => row.digest))
      for (const row of rows) {
        const references = yield* Database.query((db) =>
          db.select({ digest: BlobRefTable.digest }).from(BlobRefTable).where(eq(BlobRefTable.digest, row.digest)).all(),
        )
        if (references.length > 0) {
          result.referenced++
          continue
        }
        if (row.last_ref_removed_at == null) {
          if (!dryRun)
            yield* Database.withTransaction((db) =>
              db
                .update(BlobTable)
                .set({ last_ref_removed_at: now })
                .where(eq(BlobTable.digest, row.digest))
                .run(),
            )
          result.marked++
          continue
        }
        if (row.last_ref_removed_at > cutoff) continue
        if (yield* Effect.promise(() => exists(blobLeasePath(row.digest, root)))) {
          result.skippedLease++
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

      for (const file of yield* Effect.promise(() => canonicalFiles(root))) {
        const digest = path.basename(file)
        if (known.has(digest)) continue
        const mtime = (yield* Effect.promise(() => stat(file))).mtimeMs
        const size = (yield* Effect.promise(() => fileSize(file)))
        if (mtime > cutoff || (yield* Effect.promise(() => exists(blobLeasePath(digest, root))))) continue
        result.orphanFiles++
        result.orphanBytes += size
        if (!dryRun) yield* Effect.promise(() => rm(file, { force: true }))
      }

      for (const file of yield* Effect.promise(() => temporaryFiles(root))) {
        const mtime = (yield* Effect.promise(() => stat(file))).mtimeMs
        const size = yield* Effect.promise(() => fileSize(file))
        if (mtime > cutoff) continue
        result.tempFiles++
        result.tempBytes += size
        if (!dryRun) yield* Effect.promise(() => rm(file, { force: true }))
      }
      return result
    })
  }

  runNow(options: BlobGCOptions = {}) {
    return Effect.runPromise(this.run(options))
  }
}

export const run = (options: BlobGCOptions & { root?: string } = {}) =>
  new BlobGarbageCollector(options.root).run(options)
