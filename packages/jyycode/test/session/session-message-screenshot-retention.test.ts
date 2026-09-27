import { expect } from "bun:test"
import { Effect, Layer } from "effect"
import { eq, sql } from "drizzle-orm"
import { Database } from "@/storage/db"
import { Session } from "@/session/session"
import { SessionMessageTable } from "@/session/session.sql"
import {
  pruneLegacySessionMessageScreenshotsBatch,
  type LegacyScreenshotCursor,
} from "@/session/session-message-screenshot-retention"
import { testEffect } from "../lib/effect"

const it = testEffect(Layer.mergeAll(Session.defaultLayer))

function assistantData(index: number, toolName = "computer") {
  return {
    agent: "build",
    model: { id: "test-model", providerID: "test", variant: "default" },
    time: { created: index, completed: index + 1 },
    content: [{
      type: "tool",
      id: `call_${index}`,
      name: toolName,
      time: { created: index, completed: index + 1 },
      state: {
        status: "completed",
        input: {},
        structured: {},
        content: [
          { type: "text", text: `observation ${index}` },
          { type: "file", mime: "image/png", uri: `data:image/png;base64,${"A".repeat(10_000)}${index}` },
        ],
      },
    }],
  } as (typeof SessionMessageTable.$inferInsert)["data"]
}

it.instance("cleans legacy inline screenshots in small batches while preserving the newest three per session", () =>
  Effect.gen(function* () {
    const sessions = yield* Session.Service
    const first = yield* sessions.create({ title: "legacy screenshots A" })
    const second = yield* sessions.create({ title: "legacy screenshots B" })
    const prefix = crypto.randomUUID()
    Database.use((db) => db.insert(SessionMessageTable).values([
      ...Array.from({ length: 5 }, (_, index) => ({
        id: `${prefix}_a_${index}` as never,
        session_id: first.id,
        type: "assistant" as const,
        time_created: index,
        data: assistantData(index),
      })),
      ...Array.from({ length: 2 }, (_, index) => ({
        id: `${prefix}_b_${index}` as never,
        session_id: second.id,
        type: "assistant" as const,
        time_created: index,
        data: assistantData(index),
      })),
      {
        id: `${prefix}_b_other` as never,
        session_id: second.id,
        type: "assistant" as const,
        time_created: 3,
        data: assistantData(3, "other-tool"),
      },
    ]).run())

    const bytesBefore = Database.use((db) => db.select({ size: sql<number>`sum(length(${SessionMessageTable.data}))` })
      .from(SessionMessageTable)
      .where(eq(SessionMessageTable.session_id, first.id))
      .get()?.size ?? 0)

    let cursor: LegacyScreenshotCursor | undefined
    let removed = 0
    for (let pass = 0; pass < 100; pass++) {
      const batch = yield* pruneLegacySessionMessageScreenshotsBatch({ cursor, maxRows: 2 })
      expect(batch.scanned).toBeLessThanOrEqual(2)
      cursor = batch.cursor
      removed += batch.removed
      if (batch.done) break
    }
    expect(removed).toBe(2)

    const firstRows = Database.use((db) => db.select().from(SessionMessageTable)
      .where(eq(SessionMessageTable.session_id, first.id)).all())
    const screenshots = firstRows.map((row) => {
      const tool = (row.data as unknown as { content?: Array<{
        type: string
        state: { status: string; content: Array<{ type: string }> }
      }> }).content?.[0]
      return tool?.type === "tool" && tool.state.status === "completed"
        ? tool.state.content.filter((item) => item.type === "file")
        : []
    })
    expect(screenshots.map((items) => items.length).sort()).toEqual([0, 0, 1, 1, 1])
    for (const row of firstRows) expect(JSON.stringify(row.data)).toContain("observation")
    const bytesAfter = Database.use((db) => db.select({ size: sql<number>`sum(length(${SessionMessageTable.data}))` })
      .from(SessionMessageTable)
      .where(eq(SessionMessageTable.session_id, first.id))
      .get()?.size ?? 0)
    expect(bytesAfter).toBeLessThan(bytesBefore - 19_000)

    const secondRows = Database.use((db) => db.select().from(SessionMessageTable)
      .where(eq(SessionMessageTable.session_id, second.id)).all())
    expect(secondRows).toHaveLength(3)
    for (const row of secondRows) expect(JSON.stringify(row.data)).toContain("data:image/png;base64,")
  }),
)
