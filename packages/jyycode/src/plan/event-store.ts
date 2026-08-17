import crypto from "node:crypto"
import { and, asc, eq, gt, max } from "drizzle-orm"
import { sql } from "drizzle-orm"
import { Database } from "@/storage/db"
import { PlanEventTable } from "./events.sql"
import type { PlanEvent, PlanEventType } from "./events"

export type PlanEventInput = {
  type: PlanEventType
  session_id: string
  revision?: number
  payload: Record<string, unknown>
  at?: string
}

export interface PlanEventStore {
  append(input: PlanEventInput): PlanEvent
  readAfter(sessionId: string, seq: number): PlanEvent[]
  lastSequence(sessionId: string): number
}

function ensureSchema(db: Database.TxOrDb) {
  db.run(
    sql.raw(
      "CREATE TABLE IF NOT EXISTS plan_event (id TEXT PRIMARY KEY NOT NULL, session_id TEXT NOT NULL, seq INTEGER NOT NULL, type TEXT NOT NULL, revision INTEGER, payload TEXT NOT NULL, time_created INTEGER NOT NULL, UNIQUE(session_id, seq))",
    ),
  )
  db.run(sql.raw("CREATE INDEX IF NOT EXISTS plan_event_session_idx ON plan_event(session_id, seq)"))
  db.run(
    sql.raw(
      "CREATE TABLE IF NOT EXISTS plan_inbox (id TEXT PRIMARY KEY NOT NULL, session_id TEXT NOT NULL, task_id TEXT, run_id TEXT, kind TEXT NOT NULL, message TEXT NOT NULL, step_id TEXT, task_title TEXT, report TEXT, suggested_actions TEXT, created_at INTEGER NOT NULL, resolved_at INTEGER)",
    ),
  )
  db.run(
    sql.raw(
      "CREATE INDEX IF NOT EXISTS plan_inbox_session_resolved_idx ON plan_inbox(session_id, resolved_at, created_at)",
    ),
  )
  db.run(sql.raw("CREATE INDEX IF NOT EXISTS plan_inbox_session_task_idx ON plan_inbox(session_id, task_id)"))
}

function rowToEvent(row: typeof PlanEventTable.$inferSelect): PlanEvent {
  return {
    seq: row.seq,
    type: row.type as PlanEventType,
    session_id: row.session_id,
    ...(row.revision === null ? {} : { revision: row.revision }),
    at: new Date(row.time_created).toISOString(),
    payload: row.payload,
  }
}

export class SqlitePlanEventStore implements PlanEventStore {
  append(input: PlanEventInput) {
    return Database.legacyTransaction(
      (db) => {
        ensureSchema(db)
        const current = db
          .select({ seq: max(PlanEventTable.seq) })
          .from(PlanEventTable)
          .where(eq(PlanEventTable.session_id, input.session_id))
          .get()
        const seq = Number(current?.seq ?? -1) + 1
        const at = input.at ?? new Date().toISOString()
        const event: PlanEvent = {
          seq,
          type: input.type,
          session_id: input.session_id,
          ...(input.revision === undefined ? {} : { revision: input.revision }),
          at,
          payload: input.payload,
        }
        db.insert(PlanEventTable)
          .values({
            id: `plan_event_${input.session_id}_${seq}_${crypto.randomUUID()}`,
            session_id: input.session_id,
            seq,
            type: input.type,
            revision: input.revision ?? null,
            payload: input.payload,
            time_created: Date.parse(at),
          })
          .run()
        return event
      },
      { behavior: "immediate" },
    )
  }

  readAfter(sessionId: string, seq: number) {
    return Database.legacyQuery((db) => {
      ensureSchema(db)
      return db
        .select()
        .from(PlanEventTable)
        .where(and(eq(PlanEventTable.session_id, sessionId), gt(PlanEventTable.seq, seq)))
        .orderBy(asc(PlanEventTable.seq))
        .all()
        .map(rowToEvent)
    })
  }

  lastSequence(sessionId: string) {
    return Database.legacyQuery((db) => {
      ensureSchema(db)
      const row = db
        .select({ seq: max(PlanEventTable.seq) })
        .from(PlanEventTable)
        .where(eq(PlanEventTable.session_id, sessionId))
        .get()
      return Number(row?.seq ?? -1)
    })
  }
}

export const defaultPlanEventStore = new SqlitePlanEventStore()

export function ensurePlanEventInboxSchema() {
  Database.legacyQuery((db) => ensureSchema(db))
}

export * as PlanEventStoreModule from "./event-store"
