import crypto from "node:crypto"
import { and, asc, eq, isNull } from "drizzle-orm"
import { Database } from "@/storage/db"
import { PlanInboxTable } from "./events.sql"
import { ensurePlanEventInboxSchema } from "./event-store"
import type { InboxEntry } from "./events"

export type InboxEntryInput = Omit<InboxEntry, "id" | "created_at" | "resolved_at">

export interface PlanInboxStore {
  add(entry: InboxEntryInput): InboxEntry
  list(sessionId: string): InboxEntry[]
  pending(sessionId: string): InboxEntry[]
  resolve(sessionId: string, id: string): InboxEntry | undefined
}

function rowToEntry(row: typeof PlanInboxTable.$inferSelect): InboxEntry {
  return {
    id: row.id,
    session_id: row.session_id,
    ...(row.task_id === null ? {} : { task_id: row.task_id }),
    ...(row.run_id === null ? {} : { run_id: row.run_id }),
    kind: row.kind as InboxEntry["kind"],
    message: row.message,
    ...(row.step_id === null ? {} : { step_id: row.step_id }),
    ...(row.task_title === null ? {} : { task_title: row.task_title }),
    ...(row.report === null ? {} : { report: row.report }),
    ...(row.suggested_actions === null ? {} : { suggested_actions: row.suggested_actions }),
    created_at: new Date(row.created_at).toISOString(),
    resolved_at: row.resolved_at === null ? null : new Date(row.resolved_at).toISOString(),
  }
}

export class SqlitePlanInboxStore implements PlanInboxStore {
  add(entry: InboxEntryInput) {
    return Database.legacyTransaction(
      (db) => {
        ensurePlanEventInboxSchema()
        const id = `inbox_${crypto.randomUUID()}`
        const createdAt = Date.now()
        db.insert(PlanInboxTable)
          .values({
            id,
            session_id: entry.session_id,
            task_id: entry.task_id ?? null,
            run_id: entry.run_id ?? null,
            kind: entry.kind,
            message: entry.message,
            step_id: entry.step_id ?? null,
            task_title: entry.task_title ?? null,
            report: entry.report ?? null,
            suggested_actions: entry.suggested_actions ?? null,
            created_at: createdAt,
            resolved_at: null,
          })
          .run()
        return {
          ...entry,
          id,
          created_at: new Date(createdAt).toISOString(),
          resolved_at: null,
        }
      },
      { behavior: "immediate" },
    )
  }

  list(sessionId: string) {
    return Database.legacyQuery((db) => {
      ensurePlanEventInboxSchema()
      return db
        .select()
        .from(PlanInboxTable)
        .where(eq(PlanInboxTable.session_id, sessionId))
        .orderBy(asc(PlanInboxTable.created_at), asc(PlanInboxTable.id))
        .all()
        .map(rowToEntry)
    })
  }

  pending(sessionId: string) {
    return Database.legacyQuery((db) => {
      ensurePlanEventInboxSchema()
      return db
        .select()
        .from(PlanInboxTable)
        .where(and(eq(PlanInboxTable.session_id, sessionId), isNull(PlanInboxTable.resolved_at)))
        .orderBy(asc(PlanInboxTable.created_at), asc(PlanInboxTable.id))
        .all()
        .map(rowToEntry)
    })
  }

  resolve(sessionId: string, id: string) {
    return Database.legacyTransaction(
      (db) => {
        ensurePlanEventInboxSchema()
        const existing = db
          .select()
          .from(PlanInboxTable)
          .where(and(eq(PlanInboxTable.session_id, sessionId), eq(PlanInboxTable.id, id)))
          .get()
        if (!existing) return undefined
        const resolvedAt = Date.now()
        db.update(PlanInboxTable)
          .set({ resolved_at: resolvedAt })
          .where(and(eq(PlanInboxTable.session_id, sessionId), eq(PlanInboxTable.id, id)))
          .run()
        return rowToEntry({ ...existing, resolved_at: resolvedAt })
      },
      { behavior: "immediate" },
    )
  }
}

export const defaultPlanInboxStore = new SqlitePlanInboxStore()

export * as PlanInboxStoreModule from "./inbox-store"
