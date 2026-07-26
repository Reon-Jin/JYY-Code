export * as AgentClusterSchema from "./schema"

import { MessageID, SessionID } from "@/session/schema"
import { Schema } from "effect"

export const TaskID = Schema.String.pipe(Schema.brand("AgentClusterTaskID"))
export type TaskID = Schema.Schema.Type<typeof TaskID>

export const TaskRole = Schema.Literals([
  "researcher",
  "analyst",
  "writer",
  "chart",
  "office",
  "coder",
  "tester",
  "general",
])
export type TaskRole = Schema.Schema.Type<typeof TaskRole>

export const Complexity = Schema.Literals(["simple", "complex"])
export type Complexity = Schema.Schema.Type<typeof Complexity>

export const TaskStatus = Schema.Literals([
  "planned",
  "queued",
  "running",
  "submitted",
  "reviewing",
  "accepted",
  "revision_requested",
  "revising",
  "failed",
  "cancelled",
  "interrupted",
])
export type TaskStatus = Schema.Schema.Type<typeof TaskStatus>

export const Artifact = Schema.Struct({
  path: Schema.String,
  description: Schema.optional(Schema.String),
  kind: Schema.optional(Schema.String),
})
export type Artifact = Schema.Schema.Type<typeof Artifact>

export const PlannedTask = Schema.Struct({
  id: TaskID,
  step: Schema.Number,
  title: Schema.String,
  role: TaskRole,
  complexity: Complexity,
  model: Schema.String,
  dependencies: Schema.Array(TaskID),
  prompt: Schema.String,
  acceptanceCriteria: Schema.Array(Schema.String),
  expectedArtifacts: Schema.Array(Schema.String),
})
export type PlannedTask = Schema.Schema.Type<typeof PlannedTask>

/** The durable task-graph record persisted for a root session. */
export const TaskRecord = Schema.Struct({
  id: TaskID,
  sessionID: SessionID,
  originMessageID: Schema.optional(MessageID),
  parentTaskID: Schema.optional(TaskID),
  childSessionID: Schema.optional(SessionID),
  role: TaskRole,
  title: Schema.String,
  prompt: Schema.String,
  complexity: Complexity,
  model: Schema.String,
  status: TaskStatus,
  step: Schema.Number,
  dependencies: Schema.Array(TaskID),
  reviewRound: Schema.Number,
  acceptanceCriteria: Schema.Array(Schema.String),
  artifactPaths: Schema.Array(Schema.String),
  resultSummary: Schema.optional(Schema.String),
  reviewIssues: Schema.Array(Schema.String),
  lastEvent: Schema.optional(Schema.String),
  createdAt: Schema.Number,
  updatedAt: Schema.Number,
})
export type TaskRecord = Schema.Schema.Type<typeof TaskRecord>

export const Plan = Schema.Struct({
  goal: Schema.String,
  tasks: Schema.Array(PlannedTask),
})
export type Plan = Schema.Schema.Type<typeof Plan>

export const ReviewResult = Schema.Struct({
  taskId: TaskID,
  decision: Schema.Literals(["accepted", "revision_requested", "failed"]),
  issues: Schema.Array(Schema.String),
  revisionPrompt: Schema.optional(Schema.String),
})
export type ReviewResult = Schema.Schema.Type<typeof ReviewResult>
