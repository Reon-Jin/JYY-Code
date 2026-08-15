import { and, asc, desc, eq, gt, gte, lt, or } from "@/storage/db"
import * as Database from "@/storage/db"
import { Context, Effect, Layer, Schema } from "effect"
import { SessionMessage } from "@jyycode-ai/core/session-message"
import { SessionID } from "./schema"
import { SessionMessageTable } from "./session.sql"

export class MessageDecodeError extends Schema.TaggedErrorClass<MessageDecodeError>()("Session.MessageDecodeError", {
  sessionID: SessionID,
  messageID: SessionMessage.ID,
}) {}

export class MessageNotFoundError extends Schema.TaggedErrorClass<MessageNotFoundError>()(
  "Session.MessageNotFoundError",
  { sessionID: SessionID, messageID: Schema.String },
) {}

export type Cursor = {
  readonly id: SessionMessage.ID
  readonly time: number
  readonly direction?: "previous" | "next"
}

export type Page = {
  readonly items: SessionMessage.Message[]
  readonly more: boolean
  readonly cursor?: Cursor
}

export interface Interface {
  readonly page: (input: {
    sessionID: SessionID
    limit: number
    order?: "asc" | "desc"
    cursor?: Cursor
  }) => Effect.Effect<Page, MessageDecodeError>
  readonly get: (input: {
    sessionID: SessionID
    messageID: SessionMessage.ID
  }) => Effect.Effect<SessionMessage.Message, MessageDecodeError | MessageNotFoundError>
  readonly context: (sessionID: SessionID) => Effect.Effect<SessionMessage.Message[], MessageDecodeError>
}

export class Service extends Context.Service<Service, Interface>()("@jyycode/SessionMessage") {}

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const decode = Schema.decodeUnknownEffect(SessionMessage.Message)

    const decodeRow = (row: typeof SessionMessageTable.$inferSelect) =>
      decode({ ...row.data, id: row.id, type: row.type }).pipe(
        Effect.mapError(
          () =>
            new MessageDecodeError({
              sessionID: SessionID.make(row.session_id),
              messageID: SessionMessage.ID.make(row.id),
            }),
        ),
      )

    const page: Interface["page"] = Effect.fn("SessionMessage.page")(function* (input) {
      const direction = input.cursor?.direction ?? "next"
      let order = input.order ?? "desc"
      if (direction === "previous") order = order === "asc" ? "desc" : "asc"
      const boundary = input.cursor
        ? order === "asc"
          ? or(
              gt(SessionMessageTable.time_created, input.cursor.time),
              and(
                eq(SessionMessageTable.time_created, input.cursor.time),
                gt(SessionMessageTable.id, input.cursor.id),
              ),
            )
          : or(
              lt(SessionMessageTable.time_created, input.cursor.time),
              and(
                eq(SessionMessageTable.time_created, input.cursor.time),
                lt(SessionMessageTable.id, input.cursor.id),
              ),
            )
        : undefined
      const where = boundary ? and(eq(SessionMessageTable.session_id, input.sessionID), boundary) : eq(SessionMessageTable.session_id, input.sessionID)
      const rows = yield* Database.query((db) =>
        db
          .select()
          .from(SessionMessageTable)
          .where(where)
          .orderBy(
            order === "asc" ? asc(SessionMessageTable.time_created) : desc(SessionMessageTable.time_created),
            order === "asc" ? asc(SessionMessageTable.id) : desc(SessionMessageTable.id),
          )
          .limit(input.limit + 1)
          .all(),
      )
      const more = rows.length > input.limit
      const slice = more ? rows.slice(0, input.limit) : rows
      const items = yield* Effect.forEach(slice, decodeRow)
      if (direction === "previous") items.reverse()
      const tail = slice.at(-1)
      return {
        items,
        more,
        ...(more && tail
          ? { cursor: { id: SessionMessage.ID.make(tail.id), time: tail.time_created } }
          : {}),
      }
    })

    const get: Interface["get"] = Effect.fn("SessionMessage.get")(function* (input) {
      const row = yield* Database.query((db) =>
        db
          .select()
          .from(SessionMessageTable)
          .where(and(eq(SessionMessageTable.id, input.messageID), eq(SessionMessageTable.session_id, input.sessionID)))
          .get(),
      )
      if (!row) return yield* new MessageNotFoundError({ sessionID: input.sessionID, messageID: input.messageID })
      return yield* decodeRow(row)
    })

    const context: Interface["context"] = Effect.fn("SessionMessage.context")(function* (sessionID) {
      const rows = yield* Database.query((db) =>
        Effect.gen(function* () {
          const compaction = yield* db
            .select()
            .from(SessionMessageTable)
            .where(and(eq(SessionMessageTable.session_id, sessionID), eq(SessionMessageTable.type, "compaction")))
            .orderBy(desc(SessionMessageTable.time_created), desc(SessionMessageTable.id))
            .limit(1)
            .get()
          return yield* db
            .select()
            .from(SessionMessageTable)
            .where(
              and(
                eq(SessionMessageTable.session_id, sessionID),
                compaction
                  ? or(
                      gt(SessionMessageTable.time_created, compaction.time_created),
                      and(
                        eq(SessionMessageTable.time_created, compaction.time_created),
                        gte(SessionMessageTable.id, compaction.id),
                      ),
                    )
                  : undefined,
              ),
            )
            .orderBy(asc(SessionMessageTable.time_created), asc(SessionMessageTable.id))
            .all()
        }),
      )
      return yield* Effect.forEach(rows, decodeRow)
    })

    return Service.of({ page, get, context })
  }),
)

export const defaultLayer = layer

export * as SessionMessageStore from "./message-store"
