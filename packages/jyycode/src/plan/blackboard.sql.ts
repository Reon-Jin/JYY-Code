import { index, integer, primaryKey, sqliteTable, text } from "drizzle-orm/sqlite-core"
import { SessionTable } from "@/session/session.sql"
import { Timestamps } from "@/storage/schema.sql"

export type BlackboardAttachment = {
  type: "path" | "directory" | "url"
  value: string
}

export const BlackboardMessageTable = sqliteTable(
  "blackboard_message",
  {
    id: text().primaryKey(),
    root_session_id: text()
      .notNull()
      .references(() => SessionTable.id, { onDelete: "cascade" }),
    step_id: text().notNull(),
    parent_message_id: text(),
    author_kind: text().$type<"user" | "main_agent" | "sub_agent">().notNull(),
    author_session_id: text(),
    author_task_id: text(),
    kind: text().$type<"info" | "risk" | "blocker" | "decision" | "help">().notNull(),
    body: text().notNull(),
    mentions: text({ mode: "json" }).$type<string[]>().notNull().default([]),
    attachments: text({ mode: "json" }).$type<BlackboardAttachment[]>().notNull().default([]),
    ...Timestamps,
  },
  (table) => [
    index("blackboard_message_session_step_id_idx").on(table.root_session_id, table.step_id, table.id),
    index("blackboard_message_parent_idx").on(table.parent_message_id),
  ],
)

export const BlackboardMessageTaskTable = sqliteTable(
  "blackboard_message_task",
  {
    message_id: text()
      .notNull()
      .references(() => BlackboardMessageTable.id, { onDelete: "cascade" }),
    task_id: text().notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.message_id, table.task_id] }),
    index("blackboard_message_task_task_idx").on(table.task_id),
  ],
)

export const BlackboardReadCursorTable = sqliteTable(
  "blackboard_read_cursor",
  {
    root_session_id: text()
      .notNull()
      .references(() => SessionTable.id, { onDelete: "cascade" }),
    step_id: text().notNull(),
    participant_key: text().notNull(),
    last_message_id: text(),
    checked_at: integer().notNull(),
  },
  (table) => [primaryKey({ columns: [table.root_session_id, table.step_id, table.participant_key] })],
)
