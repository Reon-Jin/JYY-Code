export * as AgentClusterSchema from "./schema"

import { MessageID, SessionID } from "@/session/schema"
import { Schema } from "effect"

export const RunID = Schema.String.pipe(Schema.brand("AgentClusterRunID"))
export type RunID = Schema.Schema.Type<typeof RunID>

export const TaskID = Schema.String.pipe(Schema.brand("AgentClusterTaskID"))
export type TaskID = Schema.Schema.Type<typeof TaskID>

export const TaskRole = Schema.Literals([
  "researcher",
  "analyst",
  "writer",
  "chart",
  "pdf",
  "coder",
  "tester",
  "reviewer",
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
])
export type TaskStatus = Schema.Schema.Type<typeof TaskStatus>

export const RunStatus = Schema.Literals([
  "planning",
  "dispatching",
  "reviewing",
  "synthesizing",
  "completed",
  "failed",
  "cancelled",
])
export type RunStatus = Schema.Schema.Type<typeof RunStatus>

export const Artifact = Schema.Struct({
  path: Schema.String,
  description: Schema.optional(Schema.String),
  kind: Schema.optional(Schema.String),
})
export type Artifact = Schema.Schema.Type<typeof Artifact>

export const PlannedTask = Schema.Struct({
  id: TaskID,
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

export const RunRecord = Schema.Struct({
  id: RunID,
  sessionID: SessionID,
  parentMessageID: MessageID,
  enabled: Schema.Boolean,
  status: RunStatus,
  goal: Schema.String,
  plannerModel: Schema.String,
  reviewerModel: Schema.String,
  createdAt: Schema.Number,
  updatedAt: Schema.Number,
  completedAt: Schema.optional(Schema.Number),
})
export type RunRecord = Schema.Schema.Type<typeof RunRecord>
