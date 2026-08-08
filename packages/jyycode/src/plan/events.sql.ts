import { index, integer, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core"

export const PlanEventTable = sqliteTable(
  "plan_event",
  {
    id: text().primaryKey(),
    session_id: text().notNull(),
    seq: integer().notNull(),
    type: text().notNull(),
    revision: integer(),
    payload: text({ mode: "json" }).$type<Record<string, unknown>>().notNull(),
    time_created: integer().notNull(),
  },
  (table) => [
    uniqueIndex("plan_event_session_seq_idx").on(table.session_id, table.seq),
    index("plan_event_session_idx").on(table.session_id, table.seq),
  ],
)

export const PlanInboxTable = sqliteTable(
  "plan_inbox",
  {
    id: text().primaryKey(),
    session_id: text().notNull(),
    task_id: text(),
    run_id: text(),
    kind: text().notNull(),
    message: text().notNull(),
    step_id: text(),
    task_title: text(),
    report: text({ mode: "json" }).$type<{
      status: "done" | "partial" | "failed"
      summary: string
      issues: string[]
      reported_at: string
    }>(),
    suggested_actions: text({ mode: "json" }).$type<string[]>(),
    created_at: integer().notNull(),
    resolved_at: integer(),
  },
  (table) => [
    index("plan_inbox_session_resolved_idx").on(table.session_id, table.resolved_at, table.created_at),
    index("plan_inbox_session_task_idx").on(table.session_id, table.task_id),
  ],
)

export * as PlanEventsSql from "./events.sql"
