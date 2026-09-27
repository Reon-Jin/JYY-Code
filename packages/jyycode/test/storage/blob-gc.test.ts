import { expect, test } from "bun:test"
import { Database as SQLiteDatabase } from "bun:sqlite"
import { sql } from "drizzle-orm"
import { Effect } from "effect"
import { mkdir, mkdtemp, readFile, rm, stat, utimes, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { Database } from "@jyycode-ai/core/database/database"
import { BlobGarbageCollector, startBlobGCScheduler } from "../../src/storage/blob-gc"
import { BlobStore } from "../../src/storage/blob"
import { BlobTable } from "../../src/storage/blob.sql"
import { blobLeasePath, blobPath, blobRoot, blobTempRoot } from "../../src/storage/blob-path"

async function withDatabase<A>(root: string, body: Effect.Effect<A, unknown, Database.Service>) {
  return Effect.runPromise(
    Effect.gen(function* () {
      const { db } = yield* Database.Service
      yield* db.run(sql`CREATE TABLE part (id TEXT PRIMARY KEY)`)
      yield* db.run(
        sql`CREATE TABLE blob (digest TEXT PRIMARY KEY, size INTEGER NOT NULL, mime TEXT NOT NULL, created_at INTEGER NOT NULL, verified_at INTEGER NOT NULL, last_ref_removed_at INTEGER)`,
      )
      yield* db.run(
        sql`CREATE TABLE blob_ref (part_id TEXT NOT NULL, slot TEXT NOT NULL, digest TEXT NOT NULL, created_at INTEGER NOT NULL)`,
      )
      return yield* body
    }).pipe(Effect.provide(Database.layerFromPath(":memory:", Database.noMigrations)), Effect.scoped),
  )
}

test("marks unreferenced blobs before deleting them after the grace period", async () => {
  const root = await fsRoot()
  try {
    await withDatabase(
      root,
      Effect.gen(function* () {
        const { db } = yield* Database.Service
        const store = new BlobStore(root)
        const record = yield* Effect.promise(() => store.putBytes(new Uint8Array([1, 2, 3]), "image/png"))
        yield* db
          .insert(BlobTable)
          .values({
            digest: record.digest,
            size: record.size,
            mime: record.mime,
            created_at: 1,
            verified_at: 1,
            last_ref_removed_at: null,
          })
          .run()

        const gc = new BlobGarbageCollector(root)
        const marked = yield* gc.run({ now: 1_000, graceMs: 100 })
        expect(marked.marked).toBe(1)
        yield* Effect.promise(() => stat(record.path))
        const deleted = yield* gc.run({ now: 1_101, graceMs: 100 })
        expect(deleted.deleted).toBe(1)
        expect(
          yield* Effect.promise(() =>
            stat(record.path).then(
              () => false,
              () => true,
            ),
          ),
        ).toBe(true)
      }),
    )
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test("collects old unreferenced request envelopes on the first pass", async () => {
  const root = await fsRoot()
  try {
    await withDatabase(root, Effect.gen(function* () {
      const { db } = yield* Database.Service
      const record = yield* Effect.promise(() => new BlobStore(root).putBytes(
        new TextEncoder().encode('{"audit":"old"}'), "application/json",
      ))
      yield* db.insert(BlobTable).values({
        digest: record.digest, size: record.size, mime: record.mime,
        created_at: 1, verified_at: 1, last_ref_removed_at: null,
      }).run()
      const result = yield* new BlobGarbageCollector(root).run({ now: 10_000, graceMs: 100 })
      expect(result.deleted).toBe(1)
      expect(yield* Effect.promise(() => stat(record.path).then(() => true, () => false))).toBe(false)
    }))
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test("never deletes a referenced blob and respects lease files and dry-run", async () => {
  const root = await fsRoot()
  try {
    await withDatabase(
      root,
      Effect.gen(function* () {
        const { db } = yield* Database.Service
        const store = new BlobStore(root)
        const record = yield* Effect.promise(() => store.putBytes(new Uint8Array([4, 5, 6]), "image/png"))
        yield* db
          .insert(BlobTable)
          .values({
            digest: record.digest,
            size: record.size,
            mime: record.mime,
            created_at: 1,
            verified_at: 1,
            last_ref_removed_at: 1,
          })
          .run()
        yield* db.run(
          sql`INSERT INTO blob_ref(part_id, slot, digest, created_at) VALUES ('part', 'file', ${record.digest}, 1)`,
        )
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
      }),
    )
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
    await withDatabase(
      root,
      Effect.gen(function* () {
        const result = yield* new BlobGarbageCollector(root).run({ now: 10_000, graceMs: 100 })
        expect(result.orphanFiles).toBe(1)
        expect(
          yield* Effect.promise(() =>
            readFile(oldFile).then(
              () => false,
              () => true,
            ),
          ),
        ).toBe(true)
        expect(yield* Effect.promise(() => readFile(freshFile, "utf8"))).toBe("fresh")
      }),
    )
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test("keeps blobs referenced by another channel database", async () => {
  const root = await fsRoot()
  try {
    const store = new BlobStore(root)
    const record = await store.putBytes(new Uint8Array([7, 8, 9]), "image/png")
    const other = new SQLiteDatabase(path.join(root, "jyycode-beta.db"))
    try {
      other.exec("CREATE TABLE blob_ref (part_id TEXT, slot TEXT, digest TEXT, created_at INTEGER)")
      other.query("INSERT INTO blob_ref VALUES ('part', 'file', ?, 1)").run(record.digest)
    } finally {
      other.close()
    }
    await withDatabase(
      root,
      Effect.gen(function* () {
        const { db } = yield* Database.Service
        yield* db.insert(BlobTable).values({
          digest: record.digest,
          size: record.size,
          mime: record.mime,
          created_at: 1,
          verified_at: 1,
          last_ref_removed_at: 1,
        }).run()
        const result = yield* new BlobGarbageCollector(root).run({
          now: 10_000, graceMs: 0, onlyDigests: [record.digest],
        })
        expect(result.referenced).toBe(1)
        expect(result.deleted).toBe(0)
        yield* Effect.promise(() => stat(record.path))
      }),
    )
    // The same protection applies when this channel has no blob metadata row.
    await withDatabase(root, Effect.gen(function* () {
      const result = yield* new BlobGarbageCollector(root).run({
        now: 10_000, graceMs: 0, onlyDigests: [record.digest],
      })
      expect(result.orphanFiles).toBe(0)
      yield* Effect.promise(() => stat(record.path))
    }))
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test("ignores SQLite backup WAL and SHM sidecars during cross-channel checks", async () => {
  const root = await fsRoot()
  try {
    const digest = "c".repeat(64)
    const file = blobPath(digest, root)
    await mkdir(path.dirname(file), { recursive: true })
    await writeFile(file, "orphan")
    await utimes(file, 1, 1)
    await writeFile(path.join(root, "jyycode.db.backup-20260705-shm"), "not a database")
    await writeFile(path.join(root, "jyycode.db.backup-20260705-wal"), "not a database")
    await withDatabase(root, Effect.gen(function* () {
      const result = yield* new BlobGarbageCollector(root).run({ now: 10_000, graceMs: 100 })
      expect(result.orphanFiles).toBe(1)
      expect(yield* Effect.promise(() => stat(file).then(() => true, () => false))).toBe(false)
    }))
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test("targeted GC accepts zero grace and leaves unrelated blobs and temp files alone", async () => {
  const root = await fsRoot()
  try {
    await withDatabase(root, Effect.gen(function* () {
      const { db } = yield* Database.Service
      const store = new BlobStore(root)
      const target = yield* Effect.promise(() => store.putBytes(new Uint8Array([20]), "image/png"))
      const other = yield* Effect.promise(() => store.putBytes(new Uint8Array([21]), "image/png"))
      for (const record of [target, other]) {
        yield* db.insert(BlobTable).values({
          digest: record.digest,
          size: record.size,
          mime: record.mime,
          created_at: 1,
          verified_at: 1,
          last_ref_removed_at: 1,
        }).run()
      }
      const temp = path.join(blobTempRoot(root), "keep.part")
      yield* Effect.promise(() => mkdir(blobTempRoot(root), { recursive: true }))
      yield* Effect.promise(() => writeFile(temp, "temp"))
      yield* Effect.promise(() => utimes(temp, 1, 1))

      const gc = new BlobGarbageCollector(root)
      expect(() => gc.run({ onlyDigests: ["bad"] })).toThrow()
      const result = yield* gc.run({ now: 10_000, graceMs: 0, onlyDigests: [target.digest] })
      expect(result.deleted).toBe(1)
      expect(result.tempFiles).toBe(0)
      yield* Effect.promise(() => stat(other.path))
      yield* Effect.promise(() => stat(temp))
      expect(yield* Effect.promise(() => stat(target.path).then(() => false, () => true))).toBe(true)
    }))
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test("defers deletion when a channel database cannot be verified", async () => {
  const root = await fsRoot()
  try {
    const store = new BlobStore(root)
    const record = await store.putBytes(new Uint8Array([10, 11]), "image/png")
    await writeFile(path.join(root, "jyycode-beta.db"), "not a sqlite database")
    await withDatabase(root, Effect.gen(function* () {
      const { db } = yield* Database.Service
      yield* db.insert(BlobTable).values({
        digest: record.digest,
        size: record.size,
        mime: record.mime,
        created_at: 1,
        verified_at: 1,
        last_ref_removed_at: 1,
      }).run()
      const exit = yield* Effect.exit(new BlobGarbageCollector(root).run({ now: 10_000, graceMs: 100 }))
      expect(exit._tag).toBe("Failure")
      yield* Effect.promise(() => stat(record.path))
    }))
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test("schedules GC after startup and stops the timer", async () => {
  let runs = 0
  const scheduler = startBlobGCScheduler({
    startupDelayMs: 25,
    intervalMs: 100,
    run: async () => { runs++ },
  })
  try {
    expect(runs).toBe(0)
    const deadline = Date.now() + 1_000
    while (runs === 0 && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 10))
    }
    expect(runs).toBe(1)
  } finally {
    await scheduler.stop()
  }
  await new Promise((resolve) => setTimeout(resolve, 120))
  expect(runs).toBe(1)
})

async function fsRoot() {
  return await mkdtemp(path.join(os.tmpdir(), "jyycode-blob-gc-"))
}
