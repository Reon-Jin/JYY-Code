import { WorkflowRuntime } from "@/workflow/runtime"
import { WorkflowLedger } from "@/workflow/ledger"
import { WorkflowCollaboration } from "@/workflow/collaboration"
import { WorkflowGenerator } from "@/workflow/generator"
import { Effect } from "effect"
import { HttpApiBuilder, HttpApiError } from "effect/unstable/httpapi"
import { InstanceHttpApi } from "../api"
import { CreateArtifactPayload, CreateBlackboardPayload, CreateContextPayload, CreatePlanPayload, CreateReviewPayload, GeneratorInstallPayload, GeneratorPreviewPayload, PatchPayload, PinPayload, RegisterPayload, ResolveReviewPayload, RestorePayload, TransitionBlackboardPayload, TransitionPayload } from "../groups/workflow"

const badRequest = <A>(effect: Effect.Effect<A, unknown, never>) => effect.pipe(Effect.mapError(() => new HttpApiError.BadRequest({})))
const notFound = <A>(effect: Effect.Effect<A, unknown, never>) => effect.pipe(Effect.mapError(() => new HttpApiError.NotFound({})))

export const workflowHandlers = HttpApiBuilder.group(InstanceHttpApi, "workflow", (handlers) =>
  Effect.succeed(
    handlers
      .handle("register", (ctx: { payload: typeof RegisterPayload.Type }) =>
        badRequest(WorkflowRuntime.registerWorkflow(ctx.payload).pipe(Effect.as(true))),
      )
      .handle("pin", (ctx: { params: { sessionID: string }; payload: typeof PinPayload.Type }) =>
        badRequest(WorkflowRuntime.pinWorkflow({ sessionID: ctx.params.sessionID as any, ...ctx.payload }).pipe(Effect.as(true))),
      )
      .handle("getSessionPlan", (ctx: { params: { sessionID: string } }) =>
        notFound(WorkflowRuntime.getSessionRunPlan(ctx.params.sessionID as any)),
      )
      .handle("createSessionPlan", (ctx: { params: { sessionID: string }; payload: typeof CreatePlanPayload.Type }) => {
        if (ctx.payload.plan.sessionID !== ctx.params.sessionID) return Effect.fail(new HttpApiError.BadRequest({}))
        return badRequest(WorkflowRuntime.createRunPlan(ctx.payload))
      })
      .handle("getRunPlan", (ctx: { params: { runPlanID: string } }) => notFound(WorkflowRuntime.getRunPlan(ctx.params.runPlanID as any)))
      .handle("listVersions", (ctx: { params: { runPlanID: string } }) => notFound(WorkflowRuntime.listRunPlanVersions(ctx.params.runPlanID as any)))
      .handle("patch", (ctx: { params: { runPlanID: string }; payload: typeof PatchPayload.Type }) =>
        badRequest(WorkflowRuntime.patchRunPlan({ runPlanID: ctx.params.runPlanID as any, ...ctx.payload })),
      )
      .handle("restore", (ctx: { params: { runPlanID: string }; payload: typeof RestorePayload.Type }) =>
        badRequest(WorkflowRuntime.restoreRunPlanVersion({ runPlanID: ctx.params.runPlanID as any, ...ctx.payload })),
      )
      .handle("transition", (ctx: { params: { runPlanID: string; nodeID: string }; payload: typeof TransitionPayload.Type }) =>
        badRequest(
          WorkflowRuntime.getRunPlan(ctx.params.runPlanID as any).pipe(
            Effect.flatMap((plan) => WorkflowRuntime.transitionNode({ sessionID: plan.sessionID, runPlanID: plan.id, nodeID: ctx.params.nodeID as any, ...ctx.payload })),
            Effect.as(true),
          ),
        ),
      )
      .handle("listContext", (ctx: { params: { sessionID: string }; query: { query?: string; limit?: number } }) =>
        badRequest(WorkflowLedger.searchContext({ sessionID: ctx.params.sessionID as any, query: ctx.query.query, limit: ctx.query.limit })),
      )
      .handle("createContext", (ctx: { params: { sessionID: string }; payload: typeof CreateContextPayload.Type }) =>
        badRequest(WorkflowLedger.addContext({ sessionID: ctx.params.sessionID as any, ...ctx.payload })),
      )
      .handle("getContext", (ctx: { params: { contextID: string } }) => notFound(WorkflowLedger.getContext(ctx.params.contextID)))
      .handle("listArtifacts", (ctx: { params: { sessionID: string } }) =>
        badRequest(WorkflowLedger.listArtifacts(ctx.params.sessionID as any)),
      )
      .handle("createArtifact", (ctx: { params: { sessionID: string }; payload: typeof CreateArtifactPayload.Type }) =>
        badRequest(WorkflowLedger.putArtifact({ sessionID: ctx.params.sessionID as any, ...ctx.payload })),
      )
      .handle("getArtifact", (ctx: { params: { artifactID: string } }) =>
        notFound(WorkflowLedger.getArtifactByID(ctx.params.artifactID)),
      )
      .handle("listBlackboard", (ctx: { params: { sessionID: string } }) => badRequest(WorkflowCollaboration.listBlackboard(ctx.params.sessionID as any)))
      .handle("createBlackboard", (ctx: { params: { sessionID: string }; payload: typeof CreateBlackboardPayload.Type }) => badRequest(WorkflowCollaboration.createBlackboardCard({ sessionID: ctx.params.sessionID as any, ...ctx.payload })))
      .handle("transitionBlackboard", (ctx: { params: { cardID: string }; payload: typeof TransitionBlackboardPayload.Type }) => badRequest(WorkflowCollaboration.transitionBlackboard({ cardID: ctx.params.cardID, ...ctx.payload })))
      .handle("listReviews", (ctx: { params: { sessionID: string } }) => badRequest(WorkflowCollaboration.listReviewFindings(ctx.params.sessionID as any)))
      .handle("createReview", (ctx: { params: { sessionID: string }; payload: typeof CreateReviewPayload.Type }) => badRequest(WorkflowCollaboration.createReviewFinding({ sessionID: ctx.params.sessionID as any, ...ctx.payload })))
      .handle("resolveReview", (ctx: { params: { findingID: string }; payload: typeof ResolveReviewPayload.Type }) => badRequest(WorkflowCollaboration.resolveReviewFinding({ findingID: ctx.params.findingID, ...ctx.payload })))
      .handle("generatorPreview", (ctx: { payload: typeof GeneratorPreviewPayload.Type }) =>
        Effect.try({ try: () => WorkflowGenerator.preview(ctx.payload), catch: () => new HttpApiError.BadRequest({}) }),
      )
      .handle("generatorInstall", (ctx: { payload: typeof GeneratorInstallPayload.Type; query: { directory?: string } }) =>
        badRequest(WorkflowGenerator.install({ ...ctx.payload, directory: ctx.query.directory })),
      )
      .handle("listAssignments", (ctx: { params: { sessionID: string } }) => badRequest(WorkflowCollaboration.listAssignments(ctx.params.sessionID as any)))
      .handle("listEvents", (ctx: { params: { sessionID: string } }) => badRequest(WorkflowRuntime.listEvents(ctx.params.sessionID as any))),
  ),
)
