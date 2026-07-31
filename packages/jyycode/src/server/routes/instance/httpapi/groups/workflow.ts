import { AgentAssignment, Artifact, BlackboardCard, BlackboardStatus, BlackboardType, CachePolicy, ContextBlock, ContextPriority, ContextRetention, ContextSource, NodeID, NodeStatus, PlanPatch, ReviewFinding, ReviewStatus, RunPlan, RunPlanID, RunPlanVersion, Workflow, WorkflowID, WorkflowVersion } from "@/workflow/schema"
import { SessionID } from "@/session/schema"
import { Event as WorkflowEvent } from "@/workflow/event"
import { Schema } from "effect"
import { HttpApi, HttpApiEndpoint, HttpApiError, HttpApiGroup, OpenApi } from "effect/unstable/httpapi"
import { Authorization } from "../middleware/authorization"
import { InstanceContextMiddleware } from "../middleware/instance-context"
import { WorkspaceRoutingMiddleware, WorkspaceRoutingQuery, WorkspaceRoutingQueryFields } from "../middleware/workspace-routing"
import { described } from "./metadata"

export const WorkflowPaths = {
  workflows: "/workflow",
  sessionPin: "/workflow/sessions/:sessionID/pin",
  sessionPlan: "/workflow/sessions/:sessionID/run-plan",
  runPlan: "/workflow/run-plans/:runPlanID",
  versions: "/workflow/run-plans/:runPlanID/versions",
  restore: "/workflow/run-plans/:runPlanID/restore",
  patch: "/workflow/run-plans/:runPlanID/patch",
  transition: "/workflow/run-plans/:runPlanID/nodes/:nodeID/transition",
  context: "/workflow/sessions/:sessionID/context",
  contextItem: "/workflow/context/:contextID",
  artifacts: "/workflow/sessions/:sessionID/artifacts",
  artifact: "/workflow/artifacts/:artifactID",
  blackboard: "/workflow/sessions/:sessionID/blackboard",
  blackboardTransition: "/workflow/blackboard/:cardID/transition",
  reviews: "/workflow/sessions/:sessionID/reviews",
  reviewResolve: "/workflow/reviews/:findingID/resolve",
  generatorPreview: "/workflow/generator/preview",
  generatorInstall: "/workflow/generator/install",
  assignments: "/workflow/sessions/:sessionID/assignments",
  events: "/workflow/sessions/:sessionID/events",
} as const

const Author = Schema.Literals(["user", "main_agent"])
export const RegisterPayload = Schema.Struct({ workflow: Workflow, scope: Schema.Literals(["builtin", "global", "project"]), source: Schema.String, installed: Schema.optional(Schema.Boolean) })
export const PinPayload = Schema.Struct({ workflowID: WorkflowID, workflowVersion: WorkflowVersion })
export const CreatePlanPayload = Schema.Struct({ plan: RunPlan, author: Author })
export const PatchPayload = Schema.Struct({ patch: PlanPatch, author: Author })
export const RestorePayload = Schema.Struct({ version: Schema.Int.check(Schema.isGreaterThan(0)), baseVersion: Schema.Int.check(Schema.isGreaterThan(0)), author: Author })
export const TransitionPayload = Schema.Struct({
  from: NodeStatus,
  to: NodeStatus,
  detail: Schema.optional(Schema.Record(Schema.String, Schema.Unknown)),
})
export const CreateContextPayload = Schema.Struct({
  source: ContextSource,
  priority: ContextPriority,
  tokenEstimate: Schema.optional(Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))),
  provenance: Schema.String,
  retention: ContextRetention,
  cachePolicy: CachePolicy,
  scope: Schema.Record(Schema.String, Schema.Unknown),
  content: Schema.String,
  runPlanID: Schema.optional(RunPlanID),
  nodeID: Schema.optional(NodeID),
})
export const CreateArtifactPayload = Schema.Struct({
  name: Schema.String,
  mediaType: Schema.String,
  content: Schema.optional(Schema.String),
  summary: Schema.String,
  metadata: Schema.Record(Schema.String, Schema.Unknown),
  runPlanID: Schema.optional(RunPlanID),
  nodeID: Schema.optional(NodeID),
})
export const CreateBlackboardPayload = Schema.Struct({
  type: BlackboardType,
  title: Schema.String,
  authorAgentID: Schema.String,
  summary: Schema.String,
  relatedTasks: Schema.Array(NodeID),
  replaces: Schema.Array(Schema.String),
  impactScope: Schema.Literals(["low", "medium", "high"]),
  artifacts: Schema.Array(Schema.String),
})
export const TransitionBlackboardPayload = Schema.Struct({ from: BlackboardStatus, to: BlackboardStatus, approvedBy: Schema.optional(Schema.String) })
export const CreateReviewPayload = Schema.Struct({
  runPlanID: Schema.optional(RunPlanID), nodeID: Schema.optional(NodeID), authorAgentID: Schema.String,
  severity: Schema.Literals(["low", "medium", "high", "critical"]), summary: Schema.String, evidence: Schema.Array(Schema.String), suggestion: Schema.String,
})
export const ResolveReviewPayload = Schema.Struct({ status: Schema.Literals(["accepted", "rejected", "resolved"]) })
export const GeneratorPreviewPayload = Schema.Struct({ request: Schema.String, id: Schema.optional(Schema.String), displayName: Schema.optional(Schema.String) })
export const GeneratorInstallPayload = Schema.Struct({ workflow: Workflow, confirmed: Schema.Boolean, scope: Schema.optional(Schema.Literals(["global", "project"])) })
const GeneratorStatus = Schema.Literals(["draft", "incomplete_draft", "validating", "ready", "invalid", "installed"])
const GeneratorSpec = Schema.Struct({
  status: GeneratorStatus,
  identity: Schema.Struct({ name: Schema.String, displayName: Schema.String, scope: Schema.String }),
  applicability: Schema.Struct({ included: Schema.Array(Schema.String), excluded: Schema.Array(Schema.String) }),
  outputs: Schema.Array(Schema.String),
  unresolved: Schema.Array(Schema.String),
  maxConcurrency: Schema.Int,
  maxReplanCycles: Schema.Int,
})
const GeneratorValidationCheck = Schema.Struct({
  id: Schema.Literals(["schema", "dependencies", "state_machine", "acceptance", "single_simulation", "multi_simulation"]),
  valid: Schema.Boolean,
  message: Schema.String,
})
const GeneratorFile = Schema.Struct({
  path: Schema.String,
  content: Schema.String,
  kind: Schema.Literals(["workflow", "schema", "prompt", "test", "fixture", "readme", "report"]),
})
const GeneratorPreviewResult = Schema.Struct({
  status: GeneratorStatus,
  workflow: Workflow,
  spec: GeneratorSpec,
  interview: Schema.Array(Schema.Struct({ id: Schema.String, prompt: Schema.String, required: Schema.Boolean })),
  validation: Schema.Array(GeneratorValidationCheck),
  dryRuns: Schema.Array(Schema.Struct({ mode: Schema.Literals(["single", "multi"]), valid: Schema.Boolean, steps: Schema.Array(Schema.String), errors: Schema.Array(Schema.String) })),
  files: Schema.Array(GeneratorFile),
  risks: Schema.Array(Schema.String),
})

export const WorkflowApi = HttpApi.make("workflow")
  .add(
    HttpApiGroup.make("workflow")
      .add(
        HttpApiEndpoint.post("register", WorkflowPaths.workflows, {
          query: WorkspaceRoutingQuery,
          payload: RegisterPayload,
          success: described(Schema.Boolean, "Workflow registered"),
          error: HttpApiError.BadRequest,
        }),
        HttpApiEndpoint.post("pin", WorkflowPaths.sessionPin, {
          query: WorkspaceRoutingQuery,
          params: { sessionID: SessionID },
          payload: PinPayload,
          success: described(Schema.Boolean, "Workflow pinned to session"),
          error: HttpApiError.BadRequest,
        }),
        HttpApiEndpoint.get("getSessionPlan", WorkflowPaths.sessionPlan, {
          query: WorkspaceRoutingQuery,
          params: { sessionID: SessionID },
          success: described(RunPlan, "Session run plan"),
          error: HttpApiError.NotFound,
        }),
        HttpApiEndpoint.post("createSessionPlan", WorkflowPaths.sessionPlan, {
          query: WorkspaceRoutingQuery,
          params: { sessionID: SessionID },
          payload: CreatePlanPayload,
          success: described(RunPlan, "Run plan created"),
          error: HttpApiError.BadRequest,
        }),
        HttpApiEndpoint.get("getRunPlan", WorkflowPaths.runPlan, {
          query: WorkspaceRoutingQuery,
          params: { runPlanID: RunPlanID },
          success: described(RunPlan, "Run plan"),
          error: HttpApiError.NotFound,
        }),
        HttpApiEndpoint.get("listVersions", WorkflowPaths.versions, {
          query: WorkspaceRoutingQuery,
          params: { runPlanID: RunPlanID },
          success: described(Schema.Array(RunPlanVersion), "Run plan version history"),
          error: HttpApiError.NotFound,
        }),
        HttpApiEndpoint.post("patch", WorkflowPaths.patch, {
          query: WorkspaceRoutingQuery,
          params: { runPlanID: RunPlanID },
          payload: PatchPayload,
          success: described(RunPlan, "Run plan patched"),
          error: HttpApiError.BadRequest,
        }),
        HttpApiEndpoint.post("restore", WorkflowPaths.restore, {
          query: WorkspaceRoutingQuery,
          params: { runPlanID: RunPlanID },
          payload: RestorePayload,
          success: described(RunPlan, "Restored run plan"),
          error: HttpApiError.BadRequest,
        }),
        HttpApiEndpoint.post("transition", WorkflowPaths.transition, {
          query: WorkspaceRoutingQuery,
          params: { runPlanID: RunPlanID, nodeID: NodeID },
          payload: TransitionPayload,
          success: described(Schema.Boolean, "Node transitioned"),
          error: HttpApiError.BadRequest,
        }),
        HttpApiEndpoint.get("listContext", WorkflowPaths.context, {
          query: Schema.Struct({ ...WorkspaceRoutingQueryFields, query: Schema.optional(Schema.String), limit: Schema.optional(Schema.Int) }),
          params: { sessionID: SessionID },
          success: described(Schema.Array(ContextBlock), "Session context ledger"),
          error: HttpApiError.BadRequest,
        }),
        HttpApiEndpoint.post("createContext", WorkflowPaths.context, {
          query: WorkspaceRoutingQuery,
          params: { sessionID: SessionID },
          payload: CreateContextPayload,
          success: described(ContextBlock, "Context block created"),
          error: HttpApiError.BadRequest,
        }),
        HttpApiEndpoint.get("getContext", WorkflowPaths.contextItem, {
          query: WorkspaceRoutingQuery,
          params: { contextID: Schema.String },
          success: described(ContextBlock, "Context block"),
          error: HttpApiError.NotFound,
        }),
        HttpApiEndpoint.get("listArtifacts", WorkflowPaths.artifacts, {
          query: WorkspaceRoutingQuery,
          params: { sessionID: SessionID },
          success: described(Schema.Array(Artifact), "Session artifacts"),
          error: HttpApiError.BadRequest,
        }),
        HttpApiEndpoint.post("createArtifact", WorkflowPaths.artifacts, {
          query: WorkspaceRoutingQuery,
          params: { sessionID: SessionID },
          payload: CreateArtifactPayload,
          success: described(Artifact, "Artifact created"),
          error: HttpApiError.BadRequest,
        }),
        HttpApiEndpoint.get("getArtifact", WorkflowPaths.artifact, {
          query: WorkspaceRoutingQuery,
          params: { artifactID: Schema.String },
          success: described(Artifact, "Artifact"),
          error: HttpApiError.NotFound,
        }),
        HttpApiEndpoint.get("listBlackboard", WorkflowPaths.blackboard, { query: WorkspaceRoutingQuery, params: { sessionID: SessionID }, success: described(Schema.Array(BlackboardCard), "Session blackboard"), error: HttpApiError.BadRequest }),
        HttpApiEndpoint.post("createBlackboard", WorkflowPaths.blackboard, { query: WorkspaceRoutingQuery, params: { sessionID: SessionID }, payload: CreateBlackboardPayload, success: described(BlackboardCard, "Blackboard card created"), error: HttpApiError.BadRequest }),
        HttpApiEndpoint.post("transitionBlackboard", WorkflowPaths.blackboardTransition, { query: WorkspaceRoutingQuery, params: { cardID: Schema.String }, payload: TransitionBlackboardPayload, success: described(BlackboardCard, "Blackboard card transitioned"), error: HttpApiError.BadRequest }),
        HttpApiEndpoint.get("listReviews", WorkflowPaths.reviews, { query: WorkspaceRoutingQuery, params: { sessionID: SessionID }, success: described(Schema.Array(ReviewFinding), "Session review inbox"), error: HttpApiError.BadRequest }),
        HttpApiEndpoint.post("createReview", WorkflowPaths.reviews, { query: WorkspaceRoutingQuery, params: { sessionID: SessionID }, payload: CreateReviewPayload, success: described(ReviewFinding, "Review finding created"), error: HttpApiError.BadRequest }),
        HttpApiEndpoint.post("resolveReview", WorkflowPaths.reviewResolve, { query: WorkspaceRoutingQuery, params: { findingID: Schema.String }, payload: ResolveReviewPayload, success: described(ReviewFinding, "Review finding resolved"), error: HttpApiError.BadRequest }),
        HttpApiEndpoint.post("generatorPreview", WorkflowPaths.generatorPreview, { query: WorkspaceRoutingQuery, payload: GeneratorPreviewPayload, success: described(GeneratorPreviewResult, "Generated workflow preview"), error: HttpApiError.BadRequest }),
        HttpApiEndpoint.post("generatorInstall", WorkflowPaths.generatorInstall, { query: WorkspaceRoutingQuery, payload: GeneratorInstallPayload, success: described(Workflow, "Generated workflow installed"), error: HttpApiError.BadRequest }),
        HttpApiEndpoint.get("listAssignments", WorkflowPaths.assignments, { query: WorkspaceRoutingQuery, params: { sessionID: SessionID }, success: described(Schema.Array(AgentAssignment), "Session workflow assignments"), error: HttpApiError.BadRequest }),
        HttpApiEndpoint.get("listEvents", WorkflowPaths.events, { query: WorkspaceRoutingQuery, params: { sessionID: SessionID }, success: described(Schema.Array(WorkflowEvent), "Session workflow events"), error: HttpApiError.BadRequest }),
      )
      .annotateMerge(OpenApi.annotations({ title: "workflow", description: "Workflow Runtime routes." }))
      .middleware(InstanceContextMiddleware)
      .middleware(WorkspaceRoutingMiddleware)
      .middleware(Authorization),
  )
