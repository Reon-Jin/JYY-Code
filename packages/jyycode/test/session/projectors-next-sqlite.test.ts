import { expect } from "bun:test"
import { Effect, Layer } from "effect"
import * as DateTime from "effect/DateTime"
import { Database } from "@/storage/db"
import { Session } from "@/session/session"
import { SessionMessageTable } from "@/session/session.sql"
import { createSessionMessageSqliteAdapter } from "@/session/projectors-next"
import { SessionMessage } from "@jyycode-ai/core/session-message"
import { ModelV2 } from "@jyycode-ai/core/model"
import { ProviderV2 } from "@jyycode-ai/core/provider"
import { testEffect } from "../lib/effect"

const it = testEffect(Layer.mergeAll(Session.defaultLayer))

function assistantData(created: number, completed?: number) {
  return {
    agent: "build",
    model: { id: "test-model", providerID: "test", variant: "default" },
    content: [],
    time: { created, ...(completed === undefined ? {} : { completed }) },
  } as (typeof SessionMessageTable.$inferInsert)["data"]
}

it.instance("reads only the active assistant before large historical rows", () =>
  Effect.gen(function* () {
    const session = yield* (yield* Session.Service).create({ title: "projection selection" })
    const prefix = crypto.randomUUID()
    Database.use((db) =>
      db
        .insert(SessionMessageTable)
        .values([
          {
            id: `${prefix}_001` as never,
            session_id: session.id,
            type: "assistant",
            time_created: 1,
            data: { invalid: "x".repeat(1_000_000) } as never,
          },
          {
            id: `${prefix}_002` as never,
            session_id: session.id,
            type: "assistant",
            time_created: 2,
            data: assistantData(2),
          },
        ])
        .run(),
    )

    const current = Database.use((db) => createSessionMessageSqliteAdapter(db, session.id).getCurrentAssistant())
    expect(String(current?.id)).toBe(`${prefix}_002`)
  }),
)

it.instance("preserves the older incomplete assistant fallback", () =>
  Effect.gen(function* () {
    const session = yield* (yield* Session.Service).create({ title: "projection recovery" })
    const prefix = crypto.randomUUID()
    Database.use((db) =>
      db
        .insert(SessionMessageTable)
        .values([
          {
            id: `${prefix}_001` as never,
            session_id: session.id,
            type: "assistant",
            time_created: 1,
            data: assistantData(1),
          },
          {
            id: `${prefix}_002` as never,
            session_id: session.id,
            type: "assistant",
            time_created: 2,
            data: assistantData(2, 3),
          },
        ])
        .run(),
    )

    const current = Database.use((db) => createSessionMessageSqliteAdapter(db, session.id).getCurrentAssistant())
    expect(String(current?.id)).toBe(`${prefix}_001`)
  }),
)

it.instance("tracks each session separately and sees newer rows inserted outside the adapter", () =>
  Effect.gen(function* () {
    const sessions = yield* Session.Service
    const first = yield* sessions.create({ title: "projection external A" })
    const second = yield* sessions.create({ title: "projection external B" })
    const prefix = crypto.randomUUID()
    Database.use((db) => db.insert(SessionMessageTable).values([
      { id: `${prefix}_a_001` as never, session_id: first.id, type: "assistant", time_created: 1,
        data: assistantData(1, 2) },
      { id: `${prefix}_b_001` as never, session_id: second.id, type: "assistant", time_created: 1,
        data: assistantData(1) },
    ]).run())

    expect(Database.use((db) => createSessionMessageSqliteAdapter(db, first.id).getCurrentAssistant())).toBeUndefined()
    expect(String(Database.use((db) => createSessionMessageSqliteAdapter(db, second.id).getCurrentAssistant()?.id)))
      .toBe(`${prefix}_b_001`)

    // A direct database insert, as from another writer, must be found when it
    // advances the session's event ID beyond the immutable baseline.
    Database.use((db) => db.insert(SessionMessageTable).values({
      id: `${prefix}_a_002` as never,
      session_id: first.id,
      type: "assistant",
      time_created: 3,
      data: assistantData(3),
    }).run())
    expect(String(Database.use((db) => createSessionMessageSqliteAdapter(db, first.id).getCurrentAssistant()?.id)))
      .toBe(`${prefix}_a_002`)
  }),
)

it.instance("reinitializes after an older assistant event is replayed out of order", () =>
  Effect.gen(function* () {
    const session = yield* (yield* Session.Service).create({ title: "projection out of order" })
    const prefix = crypto.randomUUID()
    Database.use((db) => db.insert(SessionMessageTable).values({
      id: `${prefix}_002` as never,
      session_id: session.id,
      type: "assistant",
      time_created: 2,
      data: assistantData(2, 3),
    }).run())
    expect(Database.use((db) => createSessionMessageSqliteAdapter(db, session.id).getCurrentAssistant())).toBeUndefined()

    const replayed = new SessionMessage.Assistant({
      id: SessionMessage.ID.make(`${prefix}_001`),
      type: "assistant",
      agent: "build",
      model: {
        id: ModelV2.ID.make("test-model"),
        providerID: ProviderV2.ID.make("test"),
        variant: ModelV2.VariantID.make("default"),
      },
      content: [],
      time: { created: DateTime.makeUnsafe(1) },
    })
    Database.use((db) => createSessionMessageSqliteAdapter(db, session.id).appendMessage(replayed))
    expect(String(Database.use((db) => createSessionMessageSqliteAdapter(db, session.id).getCurrentAssistant()?.id)))
      .toBe(`${prefix}_001`)
  }),
)
