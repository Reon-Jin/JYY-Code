import { index, integer, primaryKey, sqliteTable, text } from "drizzle-orm/sqlite-core"
import { MessageTable, SessionTable } from "@/session/session.sql"
import { Timestamps } from "@/storage/schema.sql"
import type { MessageID, SessionID } from "@/session/schema"
import type { RunID, RunStatus, TaskID, TaskRole, TaskStatus, Complexity } from "./schema"

/**
 * Transitional query shape retained while callers are moved to the durable
 * session task graph. The migration no longer creates this table.
 */
export const AgentClusterRunTable = sqliteTable(
  "agent_cluster_run",
  {
    id: text().$type<RunID>().primaryKey(),
    session_id: text()
      .$type<SessionID>()
      .notNull()
      .references(() => SessionTable.id, { onDelete: "cascade" }),
    parent_message_id: text()
      .$type<MessageID>()
      .notNull()
      .references(() => MessageTable.id, { onDelete: "cascade" }),
    enabled: integer({ mode: "boolean" }).notNull().default(true),
    status: text().$type<RunStatus>().notNull(),
    goal: text().notNull(),
    planner_model: text().notNull(),
    reviewer_model: text().notNull(),
    ...Timestamps,
    completed_at: integer(),
  },
  (table) => [
    index("agent_cluster_run_session_idx").on(table.session_id),
    index("agent_cluster_run_parent_message_idx").on(table.parent_message_id),
  ],
)

export const AgentClusterTaskTable = sqliteTable(
  "agent_cluster_task",
  {
    id: text().$type<TaskID>().notNull(),
    session_id: text()
      .$type<SessionID>()
      .notNull()
      .references(() => SessionTable.id, { onDelete: "cascade" }),
    origin_message_id: text().$type<MessageID>(),
    parent_task_id: text().$type<TaskID>(),
    child_session_id: text().$type<SessionID>(),
    role: text().$type<TaskRole>().notNull(),
    title: text().notNull(),
    prompt: text().notNull(),
    complexity: text().$type<Complexity>().notNull(),
    model: text().notNull(),
    status: text().$type<TaskStatus>().notNull(),
    step: integer().notNull().default(1),
    dependencies: text({ mode: "json" }).$type<string[]>().notNull().default([]),
    review_round: integer().notNull().default(0),
    acceptance_criteria: text({ mode: "json" }).$type<string[]>().notNull(),
    artifact_paths: text({ mode: "json" }).$type<string[]>().notNull(),
    result_summary: text(),
    review_issues: text({ mode: "json" }).$type<string[]>().notNull().default([]),
    last_event: text(),
    ...Timestamps,
  },
  (table) => [
    primaryKey({ columns: [table.session_id, table.id] }),
    index("agent_cluster_task_session_idx").on(table.session_id),
    index("agent_cluster_task_child_session_idx").on(table.child_session_id),
  ],
)

export const AgentClusterEventTable = sqliteTable(
  "agent_cluster_event",
  {
    id: text().primaryKey(),
    session_id: text()
      .$type<SessionID>()
      .notNull()
      .references(() => SessionTable.id, { onDelete: "cascade" }),
    origin_message_id: text().$type<MessageID>(),
    task_id: text().$type<TaskID>(),
    type: text().notNull(),
    message: text().notNull(),
    metadata: text({ mode: "json" }).$type<Record<string, unknown>>(),
    ...Timestamps,
  },
  (table) => [
    index("agent_cluster_event_session_idx").on(table.session_id),
    index("agent_cluster_event_task_idx").on(table.task_id),
  ],
)
