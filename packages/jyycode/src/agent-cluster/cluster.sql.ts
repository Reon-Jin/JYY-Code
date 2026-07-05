import { index, integer, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core"
import { MessageTable, SessionTable } from "@/session/session.sql"
import { Timestamps } from "@/storage/schema.sql"
import type { MessageID, SessionID } from "@/session/schema"
import type { RunID, RunStatus, TaskID, TaskRole, TaskStatus, Complexity } from "./schema"

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
    status_version: integer().notNull().default(0),
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
    id: text().$type<TaskID>().primaryKey(),
    run_id: text()
      .$type<RunID>()
      .notNull()
      .references(() => AgentClusterRunTable.id, { onDelete: "cascade" }),
    plan_task_id: text().notNull(),
    parent_task_id: text().$type<TaskID>(),
    child_session_id: text().$type<SessionID>(),
    step: integer().notNull(),
    dependencies: text({ mode: "json" }).$type<string[]>().notNull(),
    role: text().$type<TaskRole>().notNull(),
    title: text().notNull(),
    prompt: text().notNull(),
    complexity: text().$type<Complexity>().notNull(),
    model: text().notNull(),
    status: text().$type<TaskStatus>().notNull(),
    status_version: integer().notNull().default(0),
    review_round: integer().notNull().default(0),
    acceptance_criteria: text({ mode: "json" }).$type<string[]>().notNull(),
    artifact_paths: text({ mode: "json" }).$type<string[]>().notNull(),
    result_text: text(),
    review_issues: text({ mode: "json" }).$type<string[]>().notNull().default("[]"),
    revision_prompt: text(),
    last_event: text(),
    submitted_at: integer(),
    accepted_at: integer(),
    ...Timestamps,
  },
  (table) => [
    index("agent_cluster_task_run_idx").on(table.run_id),
    index("agent_cluster_task_child_session_idx").on(table.child_session_id),
    uniqueIndex("agent_cluster_task_run_plan_task_idx").on(table.run_id, table.plan_task_id),
  ],
)

export const AgentClusterEventTable = sqliteTable(
  "agent_cluster_event",
  {
    id: text().primaryKey(),
    run_id: text()
      .$type<RunID>()
      .notNull()
      .references(() => AgentClusterRunTable.id, { onDelete: "cascade" }),
    task_id: text().$type<TaskID>(),
    type: text().notNull(),
    message: text().notNull(),
    metadata: text({ mode: "json" }).$type<Record<string, unknown>>(),
    ...Timestamps,
  },
  (table) => [
    index("agent_cluster_event_run_idx").on(table.run_id),
    index("agent_cluster_event_task_idx").on(table.task_id),
  ],
)
