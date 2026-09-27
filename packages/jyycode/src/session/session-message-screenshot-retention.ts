import { and, desc, eq, lt, or } from "drizzle-orm"
import { Effect } from "effect"
import { Database as CoreDatabase } from "@jyycode-ai/core/database/database"
import { Database } from "@/storage/db"
import { SessionMessageTable } from "./session.sql"
import type { SessionID } from "./schema"
import type { SessionMessage } from "@jyycode-ai/core/session-message"

const KEEP_SCREENSHOTS = 3
const MAX_ROWS_PER_BATCH = 2
const BATCH_INTERVAL_MS = 10_000

type Image = { type?: string; mime?: string; uri?: string }
type Tool = { type?: string; name?: string; state?: { content?: Image[] } }
type AssistantData = { content?: Tool[] }

export type LegacyScreenshotCursor = {
  sessionID: SessionID
  id: SessionMessage.ID
  retained: number
}

export type LegacyScreenshotBatch = {
  cursor?: LegacyScreenshotCursor
  scanned: number
  removed: number
  removedUriBytes: number
  done: boolean
}

function isComputerImage(item: Image) {
  return item.type === "file" && typeof item.uri === "string" &&
    (item.mime?.startsWith("image/") || item.uri.startsWith("data:image/"))
}

/**
 * Walk newest screenshots first so a session keeps its three most recent
 * observations. Other tool output stays intact. Rows are updated in a single
 * transaction to avoid overwriting concurrent tool results.
 */
export const pruneLegacySessionMessageScreenshotsBatch = Effect.fn(
  "SessionMessageScreenshotRetention.pruneBatch",
)(function* (input: { cursor?: LegacyScreenshotCursor; maxRows?: number } = {}) {
  const maxRows = Math.min(MAX_ROWS_PER_BATCH, input.maxRows ?? MAX_ROWS_PER_BATCH)
  if (!Number.isSafeInteger(maxRows) || maxRows < 1) throw new Error("Invalid legacy screenshot batch size")

  return yield* Database.withTransaction((db) => Effect.gen(function* () {
    const boundary = input.cursor
      ? or(
          lt(SessionMessageTable.session_id, input.cursor.sessionID),
          and(
            eq(SessionMessageTable.session_id, input.cursor.sessionID),
            lt(SessionMessageTable.id, input.cursor.id),
          ),
        )
      : undefined
    const rows = yield* db
      .select({ id: SessionMessageTable.id, sessionID: SessionMessageTable.session_id })
      .from(SessionMessageTable)
      .where(and(eq(SessionMessageTable.type, "assistant"), boundary))
      .orderBy(desc(SessionMessageTable.session_id), desc(SessionMessageTable.id))
      .limit(maxRows)
      .all()

    let cursor = input.cursor
    let removed = 0
    let removedUriBytes = 0
    for (const entry of rows) {
      const row = yield* db
        .select({ data: SessionMessageTable.data })
        .from(SessionMessageTable)
        .where(and(eq(SessionMessageTable.id, entry.id), eq(SessionMessageTable.session_id, entry.sessionID)))
        .get()
      if (!row) continue
      const data = row.data as AssistantData
      let retained = cursor?.sessionID === entry.sessionID ? cursor.retained : 0
      let changed = false
      for (const tool of [...(data.content ?? [])].reverse()) {
        if (tool.type !== "tool" || tool.name !== "computer" || !tool.state?.content) continue
        const content = tool.state.content
        for (let index = content.length - 1; index >= 0; index -= 1) {
          const item = content[index]!
          if (!isComputerImage(item)) continue
          if (retained < KEEP_SCREENSHOTS) {
            retained++
            continue
          }
          removed++
          removedUriBytes += item.uri!.length
          content.splice(index, 1)
          changed = true
        }
      }
      if (changed) {
        yield* db.update(SessionMessageTable)
          .set({ data: row.data })
          .where(and(eq(SessionMessageTable.id, entry.id), eq(SessionMessageTable.session_id, entry.sessionID)))
          .run()
      }
      cursor = { sessionID: entry.sessionID, id: entry.id, retained }
    }
    return {
      cursor,
      scanned: rows.length,
      removed,
      removedUriBytes,
      done: rows.length < maxRows,
    } satisfies LegacyScreenshotBatch
  }), { behavior: "immediate" })
})

/** Start after the server's delayed startup maintenance hook. */
export const startLegacySessionMessageScreenshotCleanup = Effect.fn(
  "SessionMessageScreenshotRetention.start",
)(function* (options: { onError?: (error: unknown) => void; onBatch?: (batch: LegacyScreenshotBatch) => void } = {}) {
  const context = yield* Effect.context<CoreDatabase.Service>()
  let cursor: LegacyScreenshotCursor | undefined
  let timer: ReturnType<typeof setTimeout> | undefined
  let stopped = false

  const schedule = (delay: number) => {
    timer = setTimeout(() => {
      timer = undefined
      if (stopped) return
      void Effect.runPromise(
        pruneLegacySessionMessageScreenshotsBatch({ cursor }).pipe(Effect.provide(context)),
      ).then((batch) => {
        if (stopped) return
        cursor = batch.cursor
        options.onBatch?.(batch)
        if (!batch.done) schedule(BATCH_INTERVAL_MS)
      }, (error) => {
        if (stopped) return
        options.onError?.(error)
        schedule(BATCH_INTERVAL_MS)
      })
    }, delay)
    timer.unref?.()
  }
  schedule(0)
  return () => {
    stopped = true
    if (timer) clearTimeout(timer)
  }
})
