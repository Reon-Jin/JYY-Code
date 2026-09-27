import { expect, test } from "bun:test"
import { sql, eq } from "drizzle-orm"
import { Effect } from "effect"
import { Database as TestDatabase } from "@jyycode-ai/core/database/database"
import { Database } from "../../src/storage/db"
import { BlobRefTable } from "../../src/storage/blob.sql"
import { PartTable } from "../../src/session/session.sql"
import { Session } from "../../src/session/session"
import type { MessageV2 } from "../../src/session/message-v2"
import { MessageID, PartID, SessionID } from "../../src/session/schema"
import { enforceComputerScreenshotBudget, pruneComputerScreenshotAttachments } from "../../src/session/computer-screenshot-retention"
import {
  flushComputerScreenshotMaintenance,
  scheduleComputerScreenshotMaintenance,
  scheduleStartupComputerScreenshotMaintenance,
} from "../../src/session/computer-screenshot-maintenance"

const sessionID = SessionID.make("ses_screenshot_retention")

function part(index: number, tool = "computer") {
  const id = PartID.make(`prt_${String(index).padStart(4, "0")}`)
  const messageID = MessageID.make(`msg_${String(index).padStart(4, "0")}`)
  const attachments: MessageV2.FilePart[] = [{
    id: PartID.make(`prt_image_${index}`), messageID, sessionID,
    type: "file", mime: "image/png", url: `blob:sha256:${String(index).padStart(64, "0")}`,
  }]
  if (index === 0) attachments.push({
    id: PartID.make("prt_other_file"), messageID, sessionID,
    type: "file", mime: "text/plain", url: `blob:sha256:${"f".repeat(64)}`,
  })
  return {
    id, messageID, sessionID, type: "tool" as const, tool, callID: `call_${index}`,
    state: {
      status: "completed" as const,
      input: {}, output: `observation ${index}`, title: tool,
      metadata: { index }, time: { start: index, end: index + 1 }, attachments,
    },
  } satisfies MessageV2.ToolPart
}

function hydrate(row: typeof PartTable.$inferSelect): MessageV2.Part {
  return { ...row.data, id: row.id, messageID: row.message_id, sessionID: row.session_id } as MessageV2.Part
}

const fakeSession = Session.Service.of({
  getPart: ({ partID }: { partID: PartID }) => Database.query((client) => client
    .select().from(PartTable).where(eq(PartTable.id, partID)).get()).pipe(
      Effect.map((row) => row ? hydrate(row) : undefined),
    ),
  updatePart: <T extends MessageV2.Part>(updated: T) => Database.withTransaction((client) => Effect.gen(function* () {
    const { id, messageID: _messageID, sessionID: _sessionID, ...data } = updated
    yield* client.update(PartTable).set({ data }).where(eq(PartTable.id, id)).run()
    yield* client.delete(BlobRefTable).where(eq(BlobRefTable.part_id, id)).run()
    if (updated.type === "tool" && updated.state.status === "completed") {
      for (const [index, attachment] of (updated.state.attachments ?? []).entries()) {
        yield* client.insert(BlobRefTable).values({
          part_id: id, slot: `tool:${index}`,
          digest: attachment.url.slice("blob:sha256:".length), created_at: 0,
        }).run()
      }
    }
    return updated
  })),
} as unknown as Session.Interface)

test("retains the latest three computer screenshots and releases older blob references in batches", async () => {
  const result = await Effect.runPromise(Effect.gen(function* () {
    const { db } = yield* TestDatabase.Service
    yield* db.run(sql`CREATE TABLE part (
      id TEXT PRIMARY KEY, message_id TEXT NOT NULL, session_id TEXT NOT NULL,
      time_created INTEGER NOT NULL, time_updated INTEGER NOT NULL, data TEXT NOT NULL
    )`)
    yield* db.run(sql`CREATE TABLE blob_ref (
      part_id TEXT NOT NULL, slot TEXT NOT NULL, digest TEXT NOT NULL, created_at INTEGER NOT NULL
    )`)
    yield* db.run(sql`CREATE TABLE blob (
      digest TEXT PRIMARY KEY, size INTEGER NOT NULL, mime TEXT NOT NULL,
      created_at INTEGER NOT NULL, verified_at INTEGER NOT NULL, last_ref_removed_at INTEGER
    )`)
    const items = [...Array.from({ length: 6 }, (_, index) => part(index)), part(6, "bash")]
    for (const item of items) {
      const { id, messageID, sessionID, ...data } = item
      yield* db.run(sql`INSERT INTO part (id, message_id, session_id, time_created, time_updated, data)
        VALUES (${id}, ${messageID}, ${sessionID}, ${item.state.time.start}, ${item.state.time.start}, ${JSON.stringify(data)})`)
      for (const [index, attachment] of item.state.attachments.entries()) {
        const digest = attachment.url.slice("blob:sha256:".length)
        yield* db.run(sql`INSERT OR IGNORE INTO blob (digest, size, mime, created_at, verified_at)
          VALUES (${digest}, ${100 + index}, ${attachment.mime}, 0, 0)`)
        yield* db.run(sql`INSERT INTO blob_ref (part_id, slot, digest, created_at)
          VALUES (${id}, ${`tool:${index}`}, ${digest}, 0)`)
      }
    }

    const sweep = (batchSize: number) => pruneComputerScreenshotAttachments({ sessionID, batchSize })
      .pipe(Effect.provideService(Session.Service, fakeSession))

    const first = yield* sweep(1)
    const concurrent = yield* Effect.all([sweep(1), sweep(1)], { concurrency: "unbounded" })
    const again = yield* sweep(1)
    const rows = yield* Database.query((client) => client.select().from(PartTable).orderBy(PartTable.id).all())
    const refs = yield* Database.query((client) => client.select().from(BlobRefTable).all())
    return { first, concurrent, again, rows: rows.map(hydrate), refs }
  }).pipe(Effect.provide(TestDatabase.layerFromPath(":memory:", TestDatabase.noMigrations)), Effect.scoped))

  expect(result.first).toEqual({ pruned: 1, more: true, released: [{ digest: "0".repeat(64), bytes: 100 }] })
  expect(result.concurrent.map((value) => value.pruned)).toEqual([1, 1])
  expect(result.concurrent.flatMap((value) => value.released.map((item) => item.digest)).sort()).toEqual([
    String(1).padStart(64, "0"), String(2).padStart(64, "0"),
  ])
  expect(result.again).toEqual({ pruned: 0, more: false, released: [] })
  for (const index of [0, 1, 2]) {
    const value = result.rows[index] as MessageV2.ToolPart
    expect(value.state.status).toBe("completed")
    if (value.state.status !== "completed") continue
    expect(value.state.attachments?.filter((attachment) => attachment.mime.startsWith("image/")) ?? []).toEqual([])
    expect(value.state.output).toBe(`observation ${index}`)
    expect(value.state.metadata).toEqual({ index })
  }
  const oldest = result.rows[0] as MessageV2.ToolPart
  if (oldest.state.status === "completed") expect(oldest.state.attachments?.[0]?.mime).toBe("text/plain")
  for (const index of [3, 4, 5, 6]) {
    const value = result.rows[index] as MessageV2.ToolPart
    if (value.state.status === "completed") expect(value.state.attachments?.[0]?.mime).toBe("image/png")
  }
  expect(result.refs.filter((item) => item.digest !== "f".repeat(64))).toHaveLength(4)
  expect(result.refs.find((item) => item.digest === "f".repeat(64))).toBeDefined()
})

test("global screenshot budget prunes old sessions while preserving the active three and unrelated images", async () => {
  const oldSessionID = SessionID.make("ses_old_screenshots")
  const result = await Effect.runPromise(Effect.gen(function* () {
    const { db } = yield* TestDatabase.Service
    yield* db.run(sql`CREATE TABLE part (
      id TEXT PRIMARY KEY, message_id TEXT NOT NULL, session_id TEXT NOT NULL,
      time_created INTEGER NOT NULL, time_updated INTEGER NOT NULL, data TEXT NOT NULL
    )`)
    yield* db.run(sql`CREATE TABLE blob_ref (
      part_id TEXT NOT NULL, slot TEXT NOT NULL, digest TEXT NOT NULL, created_at INTEGER NOT NULL
    )`)
    yield* db.run(sql`CREATE TABLE blob (
      digest TEXT PRIMARY KEY, size INTEGER NOT NULL, mime TEXT NOT NULL,
      created_at INTEGER NOT NULL, verified_at INTEGER NOT NULL, last_ref_removed_at INTEGER
    )`)
    const items = [...Array.from({ length: 7 }, (_, index) => {
      const value = part(index)
      const owner = index < 4 ? oldSessionID : sessionID
      return {
        ...value,
        sessionID: owner,
        state: { ...value.state, attachments: value.state.attachments.map((attachment) => ({ ...attachment, sessionID: owner })) },
      }
    }), part(7, "bash")]
    for (const item of items) {
      const { id, messageID, sessionID, ...data } = item
      yield* db.run(sql`INSERT INTO part (id, message_id, session_id, time_created, time_updated, data)
        VALUES (${id}, ${messageID}, ${sessionID}, ${item.state.time.start}, ${item.state.time.start}, ${JSON.stringify(data)})`)
      for (const [index, attachment] of item.state.attachments.entries()) {
        const digest = attachment.url.slice("blob:sha256:".length)
        yield* db.run(sql`INSERT OR IGNORE INTO blob (digest, size, mime, created_at, verified_at)
          VALUES (${digest}, 100, ${attachment.mime}, 0, 0)`)
        yield* db.run(sql`INSERT INTO blob_ref (part_id, slot, digest, created_at)
          VALUES (${id}, ${`tool:${index}`}, ${digest}, 0)`)
      }
    }
    // An uploaded user image happens to have the same bytes as old screenshot 0.
    // Pruning the computer reference must not remove the upload reference.
    const uploadID = PartID.make("prt_upload")
    const uploadData = JSON.stringify({ type: "file", mime: "image/png", url: `blob:sha256:${"0".repeat(64)}` })
    yield* db.run(sql`INSERT INTO part (id, message_id, session_id, time_created, time_updated, data)
      VALUES (${uploadID}, 'msg_upload', ${oldSessionID}, 0, 0, ${uploadData})`)
    yield* db.run(sql`INSERT INTO blob_ref (part_id, slot, digest, created_at)
      VALUES (${uploadID}, 'file', ${"0".repeat(64)}, 0)`)

    const enforce = () => enforceComputerScreenshotBudget({ activeSessionID: sessionID, budgetBytes: 450, batchSize: 2 })
      .pipe(Effect.provideService(Session.Service, fakeSession))
    const first = yield* enforce()
    const second = yield* enforce()
    const third = yield* enforce()
    const rows = yield* Database.query((client) => client.select().from(PartTable).orderBy(PartTable.id).all())
    const refs = yield* Database.query((client) => client.select().from(BlobRefTable).all())
    return { first, second, third, rows: rows.map(hydrate), refs }
  }).pipe(Effect.provide(TestDatabase.layerFromPath(":memory:", TestDatabase.noMigrations)), Effect.scoped))

  expect(result.first).toMatchObject({ pruned: 2, more: true, totalBytes: 500, overBudget: true })
  expect(result.second).toMatchObject({ pruned: 1, more: false, totalBytes: 400, overBudget: false })
  expect(result.third).toMatchObject({ pruned: 0, more: false, totalBytes: 400, overBudget: false })
  for (const index of [0, 1, 2]) {
    const value = result.rows[index] as MessageV2.ToolPart
    if (value.state.status === "completed") expect(value.state.attachments?.some((attachment) => attachment.mime === "image/png") ?? false).toBe(false)
  }
  for (const index of [3, 4, 5, 6, 7]) {
    const value = result.rows[index] as MessageV2.ToolPart
    if (value.state.status === "completed") expect(value.state.attachments?.[0]?.mime).toBe("image/png")
  }
  expect(result.refs.some((ref) => ref.part_id === "prt_upload" && ref.digest === "0".repeat(64))).toBe(true)
})

test("screenshot maintenance returns before touching storage and cleans up when flushed", async () => {
  const result = await Effect.runPromise(Effect.gen(function* () {
    const { db } = yield* TestDatabase.Service
    yield* db.run(sql`CREATE TABLE part (
      id TEXT PRIMARY KEY, message_id TEXT NOT NULL, session_id TEXT NOT NULL,
      time_created INTEGER NOT NULL, time_updated INTEGER NOT NULL, data TEXT NOT NULL
    )`)
    yield* db.run(sql`CREATE TABLE blob_ref (
      part_id TEXT NOT NULL, slot TEXT NOT NULL, digest TEXT NOT NULL, created_at INTEGER NOT NULL
    )`)
    yield* db.run(sql`CREATE TABLE blob (
      digest TEXT PRIMARY KEY, size INTEGER NOT NULL, mime TEXT NOT NULL,
      created_at INTEGER NOT NULL, verified_at INTEGER NOT NULL, last_ref_removed_at INTEGER
    )`)
    for (const index of [0, 1, 2, 3]) {
      const item = part(index)
      const { id, messageID, sessionID, ...data } = item
      const attachment = item.state.attachments[0]!
      const digest = attachment.url.slice("blob:sha256:".length)
      yield* db.run(sql`INSERT INTO part (id, message_id, session_id, time_created, time_updated, data)
        VALUES (${id}, ${messageID}, ${sessionID}, ${index}, ${index}, ${JSON.stringify(data)})`)
      yield* db.run(sql`INSERT INTO blob (digest, size, mime, created_at, verified_at)
        VALUES (${digest}, 100, 'image/png', 0, 0)`)
      yield* db.run(sql`INSERT INTO blob_ref (part_id, slot, digest, created_at)
        VALUES (${id}, 'tool:0', ${digest}, 0)`)
    }

    yield* scheduleComputerScreenshotMaintenance({ sessionID })
    const before = yield* Database.query((client) => client.select().from(BlobRefTable).all())
    yield* Effect.promise(() => flushComputerScreenshotMaintenance())
    const after = yield* Database.query((client) => client.select().from(BlobRefTable).all())
    return {
      before: before.filter((ref) => ref.digest !== "f".repeat(64)).length,
      after: after.filter((ref) => ref.digest !== "f".repeat(64)).length,
    }
  }).pipe(
    Effect.provideService(Session.Service, fakeSession),
    Effect.provide(TestDatabase.layerFromPath(":memory:", TestDatabase.noMigrations)),
    Effect.scoped,
  ))

  expect(result).toEqual({ before: 4, after: 3 })
})

test("startup maintenance revisits sessions left untrimmed by a prior exit", async () => {
  const otherSessionID = SessionID.make("ses_other_startup_screenshots")
  const result = await Effect.runPromise(Effect.gen(function* () {
    const { db } = yield* TestDatabase.Service
    yield* db.run(sql`CREATE TABLE part (
      id TEXT PRIMARY KEY, message_id TEXT NOT NULL, session_id TEXT NOT NULL,
      time_created INTEGER NOT NULL, time_updated INTEGER NOT NULL, data TEXT NOT NULL
    )`)
    yield* db.run(sql`CREATE TABLE blob_ref (
      part_id TEXT NOT NULL, slot TEXT NOT NULL, digest TEXT NOT NULL, created_at INTEGER NOT NULL
    )`)
    yield* db.run(sql`CREATE TABLE blob (
      digest TEXT PRIMARY KEY, size INTEGER NOT NULL, mime TEXT NOT NULL,
      created_at INTEGER NOT NULL, verified_at INTEGER NOT NULL, last_ref_removed_at INTEGER
    )`)
    for (const index of [0, 1, 2, 3, 4]) {
      const owner = index === 4 ? otherSessionID : sessionID
      const value = part(index)
      const item = {
        ...value,
        sessionID: owner,
        state: {
          ...value.state,
          attachments: value.state.attachments.map((attachment) => ({ ...attachment, sessionID: owner })),
        },
      }
      const { id, messageID, sessionID: session, ...data } = item
      const attachment = item.state.attachments[0]!
      const digest = attachment.url.slice("blob:sha256:".length)
      yield* db.run(sql`INSERT INTO part (id, message_id, session_id, time_created, time_updated, data)
        VALUES (${id}, ${messageID}, ${session}, ${index}, ${index}, ${JSON.stringify(data)})`)
      yield* db.run(sql`INSERT INTO blob (digest, size, mime, created_at, verified_at)
        VALUES (${digest}, 100, 'image/png', 0, 0)`)
      yield* db.run(sql`INSERT INTO blob_ref (part_id, slot, digest, created_at)
        VALUES (${id}, 'tool:0', ${digest}, 0)`)
    }
    const startup = yield* scheduleStartupComputerScreenshotMaintenance()
    yield* Effect.promise(() => flushComputerScreenshotMaintenance())
    const refs = yield* Database.query((client) => client.select().from(BlobRefTable).all())
    return { startup, imageRefs: refs.filter((ref) => ref.digest !== "f".repeat(64)).length }
  }).pipe(
    Effect.provideService(Session.Service, fakeSession),
    Effect.provide(TestDatabase.layerFromPath(":memory:", TestDatabase.noMigrations)),
    Effect.scoped,
  ))

  expect(result).toEqual({ startup: { sessions: 2, queued: 1 }, imageRefs: 4 })
})
