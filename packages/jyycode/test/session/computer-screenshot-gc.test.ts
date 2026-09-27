import { expect, test } from "bun:test"
import { sql } from "drizzle-orm"
import { Effect } from "effect"
import { Database } from "@jyycode-ai/core/database/database"
import { mkdtemp, rm, stat } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { BlobStore } from "../../src/storage/blob"
import { BlobTable } from "../../src/storage/blob.sql"
import { ComputerScreenshotCollector } from "../../src/session/computer-screenshot-gc"

test("batches released screenshots before deleting their unreferenced blob files", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "jyycode-screenshot-gc-test-"))
  try {
    await Effect.runPromise(Effect.gen(function* () {
      const { db } = yield* Database.Service
      yield* db.run(sql`CREATE TABLE blob (
        digest TEXT PRIMARY KEY, size INTEGER NOT NULL, mime TEXT NOT NULL,
        created_at INTEGER NOT NULL, verified_at INTEGER NOT NULL, last_ref_removed_at INTEGER
      )`)
      yield* db.run(sql`CREATE TABLE blob_ref (
        part_id TEXT NOT NULL, slot TEXT NOT NULL, digest TEXT NOT NULL, created_at INTEGER NOT NULL
      )`)
      const store = new BlobStore(root)
      const first = yield* Effect.promise(() => store.putBytes(new Uint8Array([1, 2]), "image/png"))
      const second = yield* Effect.promise(() => store.putBytes(new Uint8Array([3, 4]), "image/png"))
      for (const record of [first, second]) yield* db.insert(BlobTable).values({
        digest: record.digest, size: record.size, mime: record.mime,
        created_at: 1, verified_at: 1, last_ref_removed_at: 1,
      }).run()

      const collector = new ComputerScreenshotCollector({ root, batchBytes: 4 })
      yield* collector.collect([{ digest: first.digest, bytes: first.size }])
      expect(yield* Effect.promise(() => stat(first.path).then(() => true, () => false))).toBe(true)
      yield* collector.collect([{ digest: second.digest, bytes: second.size }])
      expect(yield* Effect.promise(() => stat(first.path).then(() => true, () => false))).toBe(false)
      expect(yield* Effect.promise(() => stat(second.path).then(() => true, () => false))).toBe(false)
    }).pipe(Effect.provide(Database.layerFromPath(":memory:", Database.noMigrations)), Effect.scoped))
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
