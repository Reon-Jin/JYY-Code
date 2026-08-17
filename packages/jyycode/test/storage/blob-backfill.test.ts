import { describe, expect, test } from "bun:test"
import { sql } from "drizzle-orm"
import { Effect } from "effect"
import { copyFile, mkdir, mkdtemp, readFile, rm, stat } from "node:fs/promises"
import crypto from "node:crypto"
import os from "node:os"
import path from "node:path"
import { Database } from "@jyycode-ai/core/database/database"
import { maintainNative } from "@jyycode-ai/core/database/database"
import { Database as BunDatabase } from "bun:sqlite"
import { BlobRefTable, BlobTable } from "../../src/storage/blob.sql"
import { blobPath, parseBlobURL } from "../../src/storage/blob-path"
import { runBlobBackfill } from "../../src/storage/blob-backfill"
import { PartTable } from "../../src/session/session.sql"
import { MessageID, PartID, SessionID } from "../../src/session/schema"

async function withDatabase<A>(root: string, body: Effect.Effect<A, unknown, Database.Service>) {
  return Effect.runPromise(
    Effect.gen(function* () {
      const { db } = yield* Database.Service
      yield* db.run(sql`CREATE TABLE session (id TEXT PRIMARY KEY)`)
      yield* db.run(
        sql`CREATE TABLE part (id TEXT PRIMARY KEY, message_id TEXT NOT NULL, session_id TEXT NOT NULL, time_created INTEGER NOT NULL, time_updated INTEGER NOT NULL, data TEXT NOT NULL)`,
      )
      yield* db.run(
        sql`CREATE TABLE blob (digest TEXT PRIMARY KEY, size INTEGER NOT NULL, mime TEXT NOT NULL, created_at INTEGER NOT NULL, verified_at INTEGER NOT NULL, last_ref_removed_at INTEGER)`,
      )
      yield* db.run(
        sql`CREATE TABLE blob_ref (part_id TEXT NOT NULL, slot TEXT NOT NULL, digest TEXT NOT NULL, created_at INTEGER NOT NULL, PRIMARY KEY (part_id, slot))`,
      )
      return yield* body
    }).pipe(Effect.provide(Database.layerFromPath(":memory:", Database.noMigrations)), Effect.scoped),
  )
}

async function withFileDatabase<A>(filename: string, body: Effect.Effect<A, unknown, Database.Service>) {
  return Effect.runPromise(
    body.pipe(Effect.provide(Database.layerFromPath(filename, Database.noMigrations)), Effect.scoped),
  )
}

async function fileDigest(filename: string) {
  const hash = crypto.createHash("sha256")
  hash.update(await readFile(filename))
  return hash.digest("hex")
}

async function removeTree(filename: string) {
  if (typeof Bun.gc === "function") Bun.gc(true)
  for (let attempt = 0; attempt < 100; attempt++) {
    try {
      await rm(filename, { recursive: true, force: true })
      return
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      if (code !== "EBUSY" && code !== "EPERM") throw error
      await new Promise((resolve) => setTimeout(resolve, 50))
    }
  }
  await rm(filename, { recursive: true, force: true })
}

async function createCopyFixture(filename: string, value: string) {
  await withFileDatabase(
    filename,
    Effect.gen(function* () {
      const { db } = yield* Database.Service
      yield* db.run(sql`CREATE TABLE session (id TEXT PRIMARY KEY)`)
      yield* db.run(
        sql`CREATE TABLE part (id TEXT PRIMARY KEY, message_id TEXT NOT NULL, session_id TEXT NOT NULL, time_created INTEGER NOT NULL, time_updated INTEGER NOT NULL, data TEXT NOT NULL)`,
      )
      yield* db.run(
        sql`CREATE TABLE blob (digest TEXT PRIMARY KEY, size INTEGER NOT NULL, mime TEXT NOT NULL, created_at INTEGER NOT NULL, verified_at INTEGER NOT NULL, last_ref_removed_at INTEGER)`,
      )
      yield* db.run(
        sql`CREATE TABLE blob_ref (part_id TEXT NOT NULL, slot TEXT NOT NULL, digest TEXT NOT NULL, created_at INTEGER NOT NULL, PRIMARY KEY (part_id, slot))`,
      )
      yield* db.run(
        sql`INSERT INTO part (id, message_id, session_id, time_created, time_updated, data) VALUES ('prt_copy', 'msg_copy', 'ses_copy', 1, 1, ${JSON.stringify({ type: "file", mime: "image/png", url: dataURL(value) })})`,
      )
    }),
  )
}

function dataURL(value: string, mime = "image/png") {
  return `data:${mime};base64,${Buffer.from(value).toString("base64")}`
}

function part(id: string, timeUpdated: number, data: unknown) {
  return {
    id: PartID.make(id),
    message_id: MessageID.make("msg_backfill"),
    session_id: SessionID.make("ses_backfill"),
    time_created: timeUpdated,
    time_updated: timeUpdated,
    data: data as never,
  }
}

describe("blob backfill", () => {
  test("is dry-run by default, migrates binary parts, and is idempotent", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "jyycode-backfill-"))
    try {
      await withDatabase(
        root,
        Effect.gen(function* () {
          const { db } = yield* Database.Service
          const original = { type: "file", mime: "image/png", url: dataURL("pixels") }
          yield* db
            .insert(PartTable)
            .values(part("prt_001", 1, original))
            .run()

          const dry = yield* runBlobBackfill({ root })
          expect(dry.dryRun).toBe(true)
          expect(dry.candidates).toBe(1)
          expect(dry.migrated).toBe(0)
          expect(
            yield* Effect.promise(() =>
              stat(path.join(root, ".jyycode", "storage", "blob-backfill.cursor.json")).then(
                () => true,
                () => false,
              ),
            ),
          ).toBe(false)

          const applied = yield* runBlobBackfill({ root, dryRun: false })
          expect(applied.migrated).toBe(1)
          expect(applied.completed).toBe(true)
          const row = yield* db.select().from(PartTable).get()
          const digest =
            row && typeof row.data === "object" && row.data && "url" in row.data
              ? parseBlobURL(String(row.data.url))
              : undefined
          expect(digest).toMatch(/^[a-f0-9]{64}$/)
          expect(yield* Effect.promise(() => readFile(blobPath(digest!, root)))).toEqual(Buffer.from("pixels"))
          expect(yield* db.select().from(BlobRefTable).all()).toHaveLength(1)

          const repeated = yield* runBlobBackfill({ root, dryRun: false })
          expect(repeated.migrated).toBe(0)
          expect(repeated.completed).toBe(true)
        }),
      )
    } finally {
      await removeTree(root)
    }
  })

  test("resumes by cursor, deduplicates shared images, preserves the watermark, and reports corrupt rows", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "jyycode-backfill-"))
    try {
      await withDatabase(
        root,
        Effect.gen(function* () {
          const { db } = yield* Database.Service
          yield* db
            .insert(PartTable)
            .values([
              part("prt_001", 1, { type: "file", mime: "image/png", url: dataURL("shared") }),
              part("prt_002", 2, { type: "file", mime: "image/png", url: dataURL("shared") }),
              part("prt_003", 3, { type: "file", mime: "image/png", url: "data:image/png;base64,%%%" }),
              part("prt_004", 999, { type: "file", mime: "image/png", url: dataURL("active") }),
            ])
            .run()

          const first = yield* runBlobBackfill({ root, dryRun: false, watermark: 10, batchSize: 1, maxBatches: 1 })
          expect(first.migrated).toBe(1)
          expect(first.completed).toBe(false)
          const resumed = yield* runBlobBackfill({ root, dryRun: false, batchSize: 2 })
          expect(resumed.migrated).toBe(1)
          expect(resumed.corrupt).toBe(1)
          expect(resumed.completed).toBe(true)
          expect(yield* db.select().from(BlobTable).all()).toHaveLength(1)
          expect((yield* db.select().from(PartTable).all()).find((row) => row.id === "prt_004")?.data).toMatchObject({
            url: dataURL("active"),
          })
        }),
      )
    } finally {
      await removeTree(root)
    }
  })

  test("concurrent runs converge on one blob and one reference", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "jyycode-backfill-"))
    try {
      await withDatabase(
        root,
        Effect.gen(function* () {
          const { db } = yield* Database.Service
          yield* db
            .insert(PartTable)
            .values(part("prt_001", 1, { type: "file", mime: "image/png", url: dataURL("race") }))
            .run()
          const [left, right] = yield* Effect.all(
            [
              runBlobBackfill({ root, dryRun: false, reset: true }),
              runBlobBackfill({ root, dryRun: false, reset: true }),
            ],
            { concurrency: "unbounded" },
          )
          expect(left.migrated + right.migrated).toBeGreaterThanOrEqual(1)
          expect(yield* db.select().from(BlobTable).all()).toHaveLength(1)
          expect(yield* db.select().from(BlobRefTable).all()).toHaveLength(1)
        }),
      )
    } finally {
      await removeTree(root)
    }
  })

  test("rehearses both database copies without touching the source files", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "jyycode-copy-rehearsal-"))
    try {
      for (const name of ["jyycode-main.db", "jyycode.db"]) {
        const sourceDb = path.join(root, "source", name)
        const copyDb = path.join(root, "copy", name)
        const copyRoot = path.join(root, "copy", name.replace(/\.db$/, "-data"))
        await mkdir(path.dirname(sourceDb), { recursive: true })
        await mkdir(path.dirname(copyDb), { recursive: true })
        await createCopyFixture(sourceDb, `${name}-payload`)

        const sourceBefore = { digest: await fileDigest(sourceDb), stat: await stat(sourceDb) }
        await copyFile(sourceDb, copyDb)
        const copyBefore = new BunDatabase(copyDb, { readonly: true, create: false })
        expect(copyBefore.query("PRAGMA integrity_check").get()).toMatchObject({ integrity_check: "ok" })
        expect(copyBefore.query("SELECT id, time_updated, data FROM part WHERE id = 'prt_copy'").all()).toHaveLength(1)
        copyBefore.close(true)

        const result = await withFileDatabase(
          copyDb,
          Effect.gen(function* () {
            const { native } = yield* Database.Service
            const dryRun = yield* runBlobBackfill({ root: copyRoot, watermark: Date.now() })
            const applied = yield* runBlobBackfill({ root: copyRoot, dryRun: false, watermark: Date.now() })
            return { dryRun, applied, integrity: maintainNative(native).integrity }
          }),
        )
        expect(result.dryRun.dryRun).toBe(true)
        expect(result.dryRun.candidates).toBe(1)
        expect(result.applied.migrated).toBe(1)
        expect(result.applied.completed).toBe(true)
        expect(result.integrity).toBe("ok")

        const copyAfter = new BunDatabase(copyDb, { readonly: true, create: false })
        expect(copyAfter.query("PRAGMA integrity_check").get()).toMatchObject({ integrity_check: "ok" })
        const migrated = copyAfter.query("SELECT data FROM part WHERE id = 'prt_copy'").get() as { data: string }
        expect(migrated.data).toContain("blob:sha256:")
        copyAfter.close(true)

        const sourceAfter = new BunDatabase(sourceDb, { readonly: true, create: false })
        const original = sourceAfter.query("SELECT data FROM part WHERE id = 'prt_copy'").get() as { data: string }
        expect(original.data).toContain("data:image/png;base64,")
        sourceAfter.close(true)
        const sourceStatAfter = await stat(sourceDb)
        expect(await fileDigest(sourceDb)).toBe(sourceBefore.digest)
        expect(sourceStatAfter.mtimeMs).toBe(sourceBefore.stat.mtimeMs)
      }
    } finally {
      await removeTree(root)
    }
  })
})
