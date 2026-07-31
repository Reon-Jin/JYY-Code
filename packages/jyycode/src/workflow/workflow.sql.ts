import { index, integer, primaryKey, sqliteTable, text } from "drizzle-orm/sqlite-core"
import { SessionTable } from "@/session/session.sql"
import { Timestamps } from "@/storage/schema.sql"
import type { SessionID } from "@/session/schema"
import type { ExecutionMode, NodeID, NodeStatus, RunPlanID, WorkflowID, WorkflowVersion } from "./schema"

export const WorkflowTemplateTable = sqliteTable("workflow_template", {
  id: text().$type<WorkflowID>().primaryKey(),
  display_name: text().notNull(),
  scope: text().notNull(),
  source: text().notNull(),
  installed: integer({ mode: "boolean" }).notNull().default(false),
  ...Timestamps,
})

export const WorkflowVersionTable = sqliteTable(
  "workflow_version",
  {
    workflow_id: text().$type<WorkflowID>().notNull().references(() => WorkflowTemplateTable.id, { onDelete: "cascade" }),
    version: text().$type<WorkflowVersion>().notNull(),
    definition: text({ mode: "json" }).$type<Record<string, unknown>>().notNull(),
    ...Timestamps,
  },
  (table) => [primaryKey({ columns: [table.workflow_id, table.version] })],
)

export const SessionWorkflowPinTable = sqliteTable(
  "session_workflow_pin",
  {
    session_id: text().$type<SessionID>().primaryKey().references(() => SessionTable.id, { onDelete: "cascade" }),
    workflow_id: text().$type<WorkflowID>().notNull(),
    workflow_version: text().$type<WorkflowVersion>().notNull(),
    ...Timestamps,
  },
  (table) => [index("session_workflow_pin_workflow_idx").on(table.workflow_id, table.workflow_version)],
)

export const RunPlanTable = sqliteTable(
  "run_plan",
  {
    id: text().$type<RunPlanID>().primaryKey(),
    session_id: text().$type<SessionID>().notNull().unique().references(() => SessionTable.id, { onDelete: "cascade" }),
    workflow_id: text().$type<WorkflowID>().notNull(),
    workflow_version: text().$type<WorkflowVersion>().notNull(),
    version: integer().notNull(),
    mode: text().$type<ExecutionMode>().notNull(),
    goal: text().notNull(),
    ...Timestamps,
  },
  (table) => [index("run_plan_workflow_idx").on(table.workflow_id, table.workflow_version)],
)

export const RunPlanVersionTable = sqliteTable(
  "run_plan_version",
  {
    run_plan_id: text().$type<RunPlanID>().notNull().references(() => RunPlanTable.id, { onDelete: "cascade" }),
    version: integer().notNull(),
    author: text().notNull(),
    reason: text().notNull(),
    snapshot: text({ mode: "json" }).$type<Record<string, unknown>>().notNull(),
    ...Timestamps,
  },
  (table) => [primaryKey({ columns: [table.run_plan_id, table.version] })],
)

export const PlanPatchOperationTable = sqliteTable(
  "plan_patch_operation",
  {
    id: text().primaryKey(),
    run_plan_id: text().$type<RunPlanID>().notNull().references(() => RunPlanTable.id, { onDelete: "cascade" }),
    version: integer().notNull(),
    ordinal: integer().notNull(),
    operation: text({ mode: "json" }).$type<Record<string, unknown>>().notNull(),
    ...Timestamps,
  },
  (table) => [index("plan_patch_operation_run_plan_idx").on(table.run_plan_id, table.version)],
)

export const WorkflowNodeRuntimeTable = sqliteTable(
  "workflow_node_runtime",
  {
    run_plan_id: text().$type<RunPlanID>().notNull().references(() => RunPlanTable.id, { onDelete: "cascade" }),
    node_id: text().$type<NodeID>().notNull(),
    status: text().$type<NodeStatus>().notNull(),
    assignee: text(),
    detail: text({ mode: "json" }).$type<Record<string, unknown>>(),
    ...Timestamps,
  },
  (table) => [primaryKey({ columns: [table.run_plan_id, table.node_id] }), index("workflow_node_runtime_status_idx").on(table.status)],
)

export const WorkflowRuntimeEventTable = sqliteTable(
  "workflow_runtime_event",
  {
    id: text().primaryKey(),
    session_id: text().$type<SessionID>().notNull().references(() => SessionTable.id, { onDelete: "cascade" }),
    run_plan_id: text().$type<RunPlanID>().references(() => RunPlanTable.id, { onDelete: "cascade" }),
    node_id: text().$type<NodeID>(),
    type: text().notNull(),
    payload: text({ mode: "json" }).$type<Record<string, unknown>>().notNull(),
    time_created: integer().notNull(),
  },
  (table) => [index("workflow_runtime_event_session_idx").on(table.session_id, table.time_created)],
)

export const WorkflowContextBlockTable = sqliteTable(
  "workflow_context_block",
  {
    id: text().primaryKey(),
    session_id: text().$type<SessionID>().notNull().references(() => SessionTable.id, { onDelete: "cascade" }),
    run_plan_id: text().$type<RunPlanID>().references(() => RunPlanTable.id, { onDelete: "cascade" }),
    node_id: text().$type<NodeID>(),
    source: text().notNull(),
    priority: text().notNull(),
    token_estimate: integer().notNull(),
    provenance: text().notNull(),
    retention: text().notNull(),
    cache_policy: text().notNull(),
    scope: text({ mode: "json" }).$type<Record<string, unknown>>().notNull(),
    content: text().notNull(),
    time_created: integer().notNull(),
  },
  (table) => [index("workflow_context_block_session_idx").on(table.session_id, table.priority, table.time_created)],
)

export const WorkflowArtifactTable = sqliteTable(
  "workflow_artifact",
  {
    id: text().primaryKey(),
    session_id: text().$type<SessionID>().notNull().references(() => SessionTable.id, { onDelete: "cascade" }),
    run_plan_id: text().$type<RunPlanID>().references(() => RunPlanTable.id, { onDelete: "cascade" }),
    node_id: text().$type<NodeID>(),
    name: text().notNull(),
    media_type: text().notNull(),
    uri: text().notNull().unique(),
    content: text(),
    summary: text().notNull(),
    metadata: text({ mode: "json" }).$type<Record<string, unknown>>().notNull(),
    time_created: integer().notNull(),
  },
  (table) => [index("workflow_artifact_session_idx").on(table.session_id, table.time_created)],
)

export const WorkflowModelCallTable = sqliteTable(
  "workflow_model_call",
  {
    id: text().primaryKey(),
    session_id: text().$type<SessionID>().notNull().references(() => SessionTable.id, { onDelete: "cascade" }),
    run_plan_id: text().$type<RunPlanID>().references(() => RunPlanTable.id, { onDelete: "cascade" }),
    node_id: text().$type<NodeID>(),
    role: text().notNull(),
    model: text().notNull(),
    context_block_ids: text({ mode: "json" }).$type<string[]>().notNull(),
    input_tokens: integer().notNull(),
    output_tokens: integer().notNull(),
    status: text().notNull(),
    time_created: integer().notNull(),
    time_completed: integer(),
  },
  (table) => [index("workflow_model_call_session_idx").on(table.session_id, table.time_created)],
)

export const WorkflowBlackboardCardTable = sqliteTable(
  "workflow_blackboard_card",
  {
    id: text().primaryKey(),
    session_id: text().$type<SessionID>().notNull().references(() => SessionTable.id, { onDelete: "cascade" }),
    type: text().notNull(),
    title: text().notNull(),
    status: text().notNull(),
    version: integer().notNull(),
    author_agent_id: text().notNull(),
    approved_by: text(),
    summary: text().notNull(),
    related_tasks: text({ mode: "json" }).$type<string[]>().notNull(),
    replaces: text({ mode: "json" }).$type<string[]>().notNull(),
    impact_scope: text().notNull(),
    artifacts: text({ mode: "json" }).$type<string[]>().notNull(),
    ...Timestamps,
  },
  (table) => [index("workflow_blackboard_session_idx").on(table.session_id, table.status, table.time_updated)],
)

export const WorkflowReviewFindingTable = sqliteTable(
  "workflow_review_finding",
  {
    id: text().primaryKey(),
    session_id: text().$type<SessionID>().notNull().references(() => SessionTable.id, { onDelete: "cascade" }),
    run_plan_id: text().$type<RunPlanID>().references(() => RunPlanTable.id, { onDelete: "cascade" }),
    node_id: text().$type<NodeID>(),
    author_agent_id: text().notNull(),
    severity: text().notNull(),
    status: text().notNull(),
    summary: text().notNull(),
    evidence: text({ mode: "json" }).$type<string[]>().notNull(),
    suggestion: text().notNull(),
    ...Timestamps,
  },
  (table) => [index("workflow_review_session_idx").on(table.session_id, table.status, table.time_updated)],
)

export const WorkflowAgentAssignmentTable = sqliteTable(
  "workflow_agent_assignment",
  {
    id: text().primaryKey(),
    session_id: text().$type<SessionID>().notNull().references(() => SessionTable.id, { onDelete: "cascade" }),
    run_plan_id: text().$type<RunPlanID>().notNull().references(() => RunPlanTable.id, { onDelete: "cascade" }),
    node_id: text().$type<NodeID>().notNull(),
    agent_id: text().notNull(),
    role: text().notNull(),
    workspace_id: text().notNull(),
    child_session_id: text().$type<SessionID>().references(() => SessionTable.id, { onDelete: "set null" }),
    status: text().notNull(),
    checkpoint: text(),
    ...Timestamps,
  },
  (table) => [index("workflow_assignment_session_idx").on(table.session_id, table.status), index("workflow_assignment_node_idx").on(table.run_plan_id, table.node_id)],
)
