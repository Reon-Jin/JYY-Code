import { expect, test } from "bun:test"
import { sql } from "drizzle-orm"
import { Effect } from "effect"
import { mkdir, mkdtemp, readFile, rm, stat, utimes, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { Database } from "@jyycode-ai/core/database/database"
import { BlobGarbageCollector } from "../../src/storage/blob-gc"
import { BlobStore } from "../../src/storage/blob"
import { BlobTable } from "../../src/storage/blob.sql"
import { blobLeasePath, blobPath, blobRoot, blobTempRoot } from "../../src/storage/blob-path"

async function withDatabase<A>(root: string, body: Effect.Effect<A, unknown, Database.Service>) {
  return Effect.runPromise(
    Effect.gen(function* () {
      const { db } = yield* Database.Service
      yield* db.run(sql`CREATE TABLE part (id TEXT PRIMARY KEY)`)
      yield* db.run(sql`CREATE TABLE blob (digest TEXT PRIMARY KEY, size INTEGER NOT NULL, mime TEXT NOT NULL, created_at INTEGER NOT NULL, verified_at INTEGER NOT NULL, last_ref_removed_at INTEGER)`)
      yield* db.run(sql`CREATE TABLE blob_ref (part_id TEXT NOT NULL, slot TEXT NOT NULL, digest TEXT NOT NULL, created_at INTEGER NOT NULL)`)
      return yield* body
    }).pipe(Effect.provide(Database.layerFromPath(":memory:", Database.noMigrations)), Effect.scoped),
  )
}

test("marks unreferenced blobs before deleting them after the grace period", async () => {
  const root = await fsRoot()
  try {
    await withDatabase(root, Effect.gen(function* () {
      const { db } = yield* Database.Service
      const store = new BlobStore(root)
      const record = yield* Effect.promise(() => store.putBytes(new Uint8Array([1, 2, 3]), "image/png"))
      yield* db.insert(BlobTable).values({
        digest: record.digest,
        size: record.size,
        mime: record.mime,
        created_at: 1,
        verified_at: 1,
        last_ref_removed_at: null,
      }).run()

      const gc = new BlobGarbageCollector(root)
      const marked = yield* gc.run({ now: 1_000, graceMs: 100 })
      expect(marked.marked).toBe(1)
      yield* Effect.promise(() => stat(record.path))
      const deleted = yield* gc.run({ now: 1_101, graceMs: 100 })
      expect(deleted.deleted).toBe(1)
      expect(yield* Effect.promise(() => stat(record.path).then(() => false, () => true))).toBe(true)
    }))
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test("never deletes a referenced blob and respects lease files and dry-run", async () => {
  const root = await fsRoot()
  try {
    await withDatabase(root, Effect.gen(function* () {
      const { db } = yield* Database.Service
      const store = new BlobStore(root)
      const record = yield* Effect.promise(() => store.putBytes(new Uint8Array([4, 5, 6]), "image/png"))
      yield* db.insert(BlobTable).values({
        digest: record.digest,
        size: record.size,
        mime: record.mime,
        created_at: 1,
        verified_at: 1,
        last_ref_removed_at: 1,
      }).run()
      yield* db.run(sql`INSERT INTO blob_ref(part_id, slot, digest, created_at) VALUES ('part', 'file', ${record.digest}, 1)`)
      const gc = new BlobGarbageCollector(root)
      const referenced = yield* gc.run({ now: 10_000, graceMs: 100 })
      expect(referenced.referenced).toBe(1)
      yield* Effect.promise(() => stat(record.path))

      yield* db.run(sql`DELETE FROM blob_ref WHERE digest = ${record.digest}`)
      yield* Effect.promise(() => mkdir(blobTempRoot(root), { recursive: true }))
      yield* Effect.promise(() => writeFile(blobLeasePath(record.digest, root), "lease"))
      const leased = yield* gc.run({ now: 10_000, graceMs: 100 })
      expect(leased.skippedLease).toBe(1)
      yield* Effect.promise(() => stat(record.path))

      yield* Effect.promise(() => rm(blobLeasePath(record.digest, root), { force: true }))
      const dryRun = yield* gc.run({ now: 10_000, graceMs: 100, dryRun: true })
      expect(dryRun.eligible).toBe(1)
      yield* Effect.promise(() => stat(record.path))
    }))
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test("removes old orphaned canonical files but keeps fresh ones", async () => {
  const root = await fsRoot()
  try {
    const oldDigest = "a".repeat(64)
    const freshDigest = "b".repeat(64)
    await mkdir(path.join(blobRoot(root), "aa"), { recursive: true })
    await mkdir(path.join(blobRoot(root), "bb"), { recursive: true })
    const oldFile = blobPath(oldDigest, root)
    const freshFile = blobPath(freshDigest, root)
    await writeFile(oldFile, "old")
    await writeFile(freshFile, "fresh")
    await utimes(oldFile, 1, 1)
    await withDatabase(root, Effect.gen(function* () {
      const result = yield* new BlobGarbageCollector(root).run({ now: 10_000, graceMs: 100 })
      expect(result.orphanFiles).toBe(1)
      expect(yield* Effect.promise(() => readFile(oldFile).then(() => false, () => true))).toBe(true)
      expect(yield* Effect.promise(() => readFile(freshFile, "utf8"))).toBe("fresh")
    }))
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

async function fsRoot() {
  return await mkdtemp(path.join(os.tmpdir(), "jyycode-blob-gc-"))
}
