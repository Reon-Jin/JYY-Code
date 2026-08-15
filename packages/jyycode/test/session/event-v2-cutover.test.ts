import { expect, test } from "bun:test"
import { Effect, Layer } from "effect"
import * as DateTime from "effect/DateTime"
import { eq } from "drizzle-orm"
import { SessionMessage } from "@jyycode-ai/core/session-message"
import { EventTable } from "@/sync/event.sql"
import { MessageTable, SessionMessageTable } from "@/session/session.sql"
import { MessageID } from "@/session/schema"
import { ModelID, ProviderID } from "@/provider/schema"
import { Session } from "@/session/session"
import { SessionV2 } from "@/v2/session"
import { Database } from "@/storage/db"
import { testEffect } from "../lib/effect"

const it = testEffect(Layer.mergeAll(Session.defaultLayer, SessionV2.defaultLayer))

test("the V2 session read contract is backed by SessionMessageService", async () => {
  const source = await Bun.file(new URL("../../src/v2/session.ts", import.meta.url)).text()
  expect(source).toContain("SessionMessageService")
  expect(source).not.toMatch(/MessageTable|PartTable/)
  expect(source).toContain("messages.page")
  expect(source).toContain("messages.context")
})

it.instance("reads the V2 projection when legacy message rows are corrupt", () =>
  Effect.gen(function* () {
    const legacy = yield* Session.Service
    const session = yield* legacy.create({ title: "EventV2 cutover" })
    const eventMessage = yield* legacy.updateMessage({
      id: MessageID.ascending(),
      role: "user",
      sessionID: session.id,
      agent: "build",
      model: { providerID: ProviderID.make("test"), modelID: ModelID.make("test") },
      time: { created: Date.now() },
    })

    const v2Message = new SessionMessage.User({
      id: SessionMessage.ID.create(),
      type: "user",
      text: "projection source",
      files: [],
      agents: [],
      references: [],
      time: { created: DateTime.makeUnsafe(Date.now()) },
    })
    Database.use((db) =>
      db
        .insert(SessionMessageTable)
        .values({
          id: v2Message.id,
          session_id: session.id,
          type: v2Message.type,
          time_created: DateTime.toEpochMillis(v2Message.time.created),
          data: {
            text: v2Message.text,
            files: v2Message.files,
            agents: v2Message.agents,
            references: v2Message.references,
            time: { created: DateTime.toEpochMillis(v2Message.time.created) },
          },
        } as typeof SessionMessageTable.$inferInsert)
        .run(),
    )
    Database.use((db) =>
      db
        .update(MessageTable)
        .set({ data: {} as never })
        .where(eq(MessageTable.id, eventMessage.id))
        .run(),
    )

    const v2 = yield* SessionV2.Service
    const messages = yield* v2.messages({ sessionID: session.id })
    const context = yield* v2.context(session.id)
    expect(messages).toHaveLength(1)
    expect(messages[0]).toMatchObject({ type: "user", text: "projection source" })
    expect(context).toEqual(messages)
  }),
)

it.instance("publishes legacy API updates as durable EventV2 facts", () =>
  Effect.gen(function* () {
    const legacy = yield* Session.Service
    const session = yield* legacy.create({ title: "EventV2 writes" })
    yield* legacy.updateMessage({
      id: MessageID.ascending(),
      role: "user",
      sessionID: session.id,
      agent: "build",
      model: { providerID: ProviderID.make("test"), modelID: ModelID.make("test") },
      time: { created: Date.now() },
    })

    const rows = Database.use((db) =>
      db.select({ type: EventTable.type }).from(EventTable).where(eq(EventTable.aggregate_id, session.id)).all(),
    )
    expect(rows.map((row) => row.type)).toContain("session.next.message.updated.1")
  }),
)
