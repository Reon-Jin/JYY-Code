export * as WorkflowSchema from "./schema"

import { Schema } from "effect"
import { SessionID } from "@/session/schema"

export const WorkflowID = Schema.String.pipe(Schema.brand("WorkflowID"))
export type WorkflowID = Schema.Schema.Type<typeof WorkflowID>

export const WorkflowVersion = Schema.String.pipe(Schema.brand("WorkflowVersion"))
export type WorkflowVersion = Schema.Schema.Type<typeof WorkflowVersion>

export const RunPlanID = Schema.String.pipe(Schema.brand("RunPlanID"))
export type RunPlanID = Schema.Schema.Type<typeof RunPlanID>

export const NodeID = Schema.String.pipe(Schema.brand("WorkflowNodeID"))
export type NodeID = Schema.Schema.Type<typeof NodeID>

export const ExecutionMode = Schema.Literals(["single", "multi"])
export type ExecutionMode = Schema.Schema.Type<typeof ExecutionMode>

export const NodeStatus = Schema.Literals([
  "planned",
  "ready",
  "running",
  "submitted",
  "reviewing",
  "accepted",
  "revision_requested",
  "revising",
  "interrupted",
  "needs_validation",
  "checkpointing",
  "checkpointed",
  "reassigned",
  "failed",
  "replan_requested",
  "blocked",
  "failed_with_report",
])
export type NodeStatus = Schema.Schema.Type<typeof NodeStatus>

export const ContextSource = Schema.Literals([
  "system",
  "workflow",
  "run_plan",
  "user_constraint",
  "memory",
  "conversation",
  "task",
  "artifact",
  "tool_result",
  "review",
  "compaction",
  "blackboard",
])
export type ContextSource = Schema.Schema.Type<typeof ContextSource>

export const ContextPriority = Schema.Literals(["critical", "high", "normal", "low"])
export type ContextPriority = Schema.Schema.Type<typeof ContextPriority>

export const ContextRetention = Schema.Literals(["turn", "task", "session", "persistent"])
export type ContextRetention = Schema.Schema.Type<typeof ContextRetention>

export const CachePolicy = Schema.Literals(["stable", "volatile", "no_cache"])
export type CachePolicy = Schema.Schema.Type<typeof CachePolicy>

export const AcceptanceRule = Schema.Struct({
  id: Schema.String,
  title: Schema.String,
  required: Schema.Boolean,
})
export type AcceptanceRule = Schema.Schema.Type<typeof AcceptanceRule>

export const WorkflowTask = Schema.Struct({
  id: NodeID,
  title: Schema.String,
  dependsOn: Schema.Array(NodeID),
  acceptance: Schema.Array(AcceptanceRule),
})
export type WorkflowTask = Schema.Schema.Type<typeof WorkflowTask>

export const WorkflowStep = Schema.Struct({
  id: NodeID,
  title: Schema.String,
  dependsOn: Schema.Array(NodeID),
  tasks: Schema.Array(WorkflowTask),
})
export type WorkflowStep = Schema.Schema.Type<typeof WorkflowStep>

export const WorkflowStage = Schema.Struct({
  id: NodeID,
  title: Schema.String,
  dependsOn: Schema.Array(NodeID),
  steps: Schema.Array(WorkflowStep),
})
export type WorkflowStage = Schema.Schema.Type<typeof WorkflowStage>

export const Workflow = Schema.Struct({
  id: WorkflowID,
  version: WorkflowVersion,
  displayName: Schema.String,
  supports: Schema.Struct({ single: Schema.Boolean, multi: Schema.Boolean }),
  stages: Schema.Array(WorkflowStage),
})
export type Workflow = Schema.Schema.Type<typeof Workflow>

export const RunPlanTask = Schema.Struct({
  id: NodeID,
  title: Schema.String,
  stageID: NodeID,
  stepID: NodeID,
  dependsOn: Schema.Array(NodeID),
  status: NodeStatus,
  assignee: Schema.optional(Schema.String),
  role: Schema.optional(Schema.String),
  prompt: Schema.optional(Schema.String),
  model: Schema.optional(Schema.String),
  complexity: Schema.optional(Schema.Literals(["simple", "complex"])),
  expectedArtifacts: Schema.optional(Schema.Array(Schema.String)),
  acceptance: Schema.Array(AcceptanceRule),
})
export type RunPlanTask = Schema.Schema.Type<typeof RunPlanTask>

export const RunPlan = Schema.Struct({
  id: RunPlanID,
  sessionID: SessionID,
  workflowID: WorkflowID,
  workflowVersion: WorkflowVersion,
  version: Schema.Int.check(Schema.isGreaterThan(0)),
  mode: ExecutionMode,
  goal: Schema.String,
  tasks: Schema.Array(RunPlanTask),
  createdAt: Schema.Number,
  updatedAt: Schema.Number,
})
export type RunPlan = Schema.Schema.Type<typeof RunPlan>

export const RunPlanVersion = Schema.Struct({
  version: Schema.Int.check(Schema.isGreaterThan(0)),
  author: Schema.Literals(["user", "main_agent"]),
  reason: Schema.String,
  snapshot: RunPlan,
  createdAt: Schema.Number,
})
export type RunPlanVersion = Schema.Schema.Type<typeof RunPlanVersion>

export const ContextBlock = Schema.Struct({
  id: Schema.String,
  sessionID: SessionID,
  runPlanID: Schema.optional(RunPlanID),
  nodeID: Schema.optional(NodeID),
  source: ContextSource,
  priority: ContextPriority,
  tokenEstimate: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  provenance: Schema.String,
  retention: ContextRetention,
  cachePolicy: CachePolicy,
  scope: Schema.Record(Schema.String, Schema.Unknown),
  content: Schema.String,
  createdAt: Schema.Number,
})
export type ContextBlock = Schema.Schema.Type<typeof ContextBlock>

export const Artifact = Schema.Struct({
  id: Schema.String,
  sessionID: SessionID,
  runPlanID: Schema.optional(RunPlanID),
  nodeID: Schema.optional(NodeID),
  name: Schema.String,
  mediaType: Schema.String,
  uri: Schema.String,
  content: Schema.optional(Schema.String),
  summary: Schema.String,
  metadata: Schema.Record(Schema.String, Schema.Unknown),
  createdAt: Schema.Number,
})
export type Artifact = Schema.Schema.Type<typeof Artifact>

export const ModelCall = Schema.Struct({
  id: Schema.String,
  sessionID: SessionID,
  runPlanID: Schema.optional(RunPlanID),
  nodeID: Schema.optional(NodeID),
  role: Schema.String,
  model: Schema.String,
  contextBlockIDs: Schema.Array(Schema.String),
  inputTokens: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  outputTokens: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  status: Schema.Literals(["started", "completed", "failed"]),
  createdAt: Schema.Number,
  completedAt: Schema.optional(Schema.Number),
})
export type ModelCall = Schema.Schema.Type<typeof ModelCall>

export const BlackboardType = Schema.Literals(["decision", "contract", "constraint", "evidence", "risk", "proposal", "blocker"])
export type BlackboardType = Schema.Schema.Type<typeof BlackboardType>

export const BlackboardStatus = Schema.Literals(["draft", "published", "accepted", "superseded", "rejected"])
export type BlackboardStatus = Schema.Schema.Type<typeof BlackboardStatus>

export const BlackboardCard = Schema.Struct({
  id: Schema.String,
  sessionID: SessionID,
  type: BlackboardType,
  title: Schema.String,
  status: BlackboardStatus,
  version: Schema.Int.check(Schema.isGreaterThan(0)),
  authorAgentID: Schema.String,
  approvedBy: Schema.optional(Schema.String),
  summary: Schema.String,
  relatedTasks: Schema.Array(NodeID),
  replaces: Schema.Array(Schema.String),
  impactScope: Schema.Literals(["low", "medium", "high"]),
  artifacts: Schema.Array(Schema.String),
  createdAt: Schema.Number,
  updatedAt: Schema.Number,
})
export type BlackboardCard = Schema.Schema.Type<typeof BlackboardCard>

export const ReviewStatus = Schema.Literals(["open", "accepted", "rejected", "resolved"])
export type ReviewStatus = Schema.Schema.Type<typeof ReviewStatus>

export const ReviewFinding = Schema.Struct({
  id: Schema.String,
  sessionID: SessionID,
  runPlanID: Schema.optional(RunPlanID),
  nodeID: Schema.optional(NodeID),
  authorAgentID: Schema.String,
  severity: Schema.Literals(["low", "medium", "high", "critical"]),
  status: ReviewStatus,
  summary: Schema.String,
  evidence: Schema.Array(Schema.String),
  suggestion: Schema.String,
  createdAt: Schema.Number,
  updatedAt: Schema.Number,
})
export type ReviewFinding = Schema.Schema.Type<typeof ReviewFinding>

export const AgentAssignmentStatus = Schema.Literals(["assigned", "running", "checkpointed", "completed", "failed", "interrupted"])
export type AgentAssignmentStatus = Schema.Schema.Type<typeof AgentAssignmentStatus>

export const AgentAssignment = Schema.Struct({
  id: Schema.String,
  sessionID: SessionID,
  runPlanID: RunPlanID,
  nodeID: NodeID,
  agentID: Schema.String,
  role: Schema.String,
  workspaceID: Schema.String,
  childSessionID: Schema.optional(SessionID),
  status: AgentAssignmentStatus,
  checkpoint: Schema.optional(Schema.String),
  createdAt: Schema.Number,
  updatedAt: Schema.Number,
})
export type AgentAssignment = Schema.Schema.Type<typeof AgentAssignment>

export const PlanPatchOperation = Schema.Union([
  Schema.Struct({ type: Schema.Literal("add_task"), task: RunPlanTask }),
  Schema.Struct({
    type: Schema.Literal("update_task"),
    taskID: NodeID,
    title: Schema.optional(Schema.String),
    dependsOn: Schema.optional(Schema.Array(NodeID)),
    role: Schema.optional(Schema.String),
    prompt: Schema.optional(Schema.String),
    model: Schema.optional(Schema.String),
    complexity: Schema.optional(Schema.Literals(["simple", "complex"])),
    expectedArtifacts: Schema.optional(Schema.Array(Schema.String)),
    acceptance: Schema.optional(Schema.Array(AcceptanceRule)),
  }),
  Schema.Struct({ type: Schema.Literal("remove_task"), taskID: NodeID }),
  Schema.Struct({ type: Schema.Literal("set_mode"), mode: ExecutionMode }),
])
export type PlanPatchOperation = Schema.Schema.Type<typeof PlanPatchOperation>

export const PlanPatch = Schema.Struct({
  baseVersion: Schema.Int.check(Schema.isGreaterThan(0)),
  reason: Schema.String,
  operations: Schema.Array(PlanPatchOperation).check(Schema.isMinLength(1)),
})
export type PlanPatch = Schema.Schema.Type<typeof PlanPatch>
