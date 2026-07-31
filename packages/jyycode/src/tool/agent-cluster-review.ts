import * as Tool from "./tool"
import DESCRIPTION from "./agent-cluster-review.txt"
import { Config } from "@/config/config"
import { ConfigAgentCluster } from "@/config/agent-cluster"
import { Session } from "@/session/session"
import { SessionID } from "@/session/schema"
import { AppFileSystem } from "@jyycode-ai/core/filesystem"
import path from "path"
import { Effect, Schema } from "effect"
import { WorkflowCollaboration } from "@/workflow/collaboration"
import { WorkflowExecutor } from "@/workflow/executor"
import { WorkflowRuntime } from "@/workflow/runtime"
import { NodeID } from "@/workflow/schema"

const Check = Schema.Struct({
  criterion: Schema.String,
  passed: Schema.Boolean,
  evidence: Schema.String,
})

const Parameters = Schema.Struct({
  task_id: Schema.String.annotate({
    description: "The planned cluster task id, or the child ses_... id bound to that planned task",
  }),
  decision: Schema.Literals(["accepted", "revision_requested", "failed"]),
  checks: Schema.Array(Check).annotate({
    description:
      "One check per acceptance criterion, each with passed=true and concrete evidence. " +
      "There must be at least as many checks as there are acceptance criteria. " +
      "Text matching is NOT required — just ensure every criterion is covered and passes.",
  }),
  issues: Schema.Array(Schema.String).annotate({
    description: "Specific unresolved issues. Required for revision_requested and failed.",
  }),
  revision_prompt: Schema.optional(Schema.String).annotate({
    description: "Concrete instructions for resuming the same child session when decision is revision_requested",
  }),
})

function agentClusterSessionID(ctx: Tool.Context): SessionID | undefined {
  const promptOps = ctx.extra?.promptOps as { agentClusterSessionID?: SessionID } | undefined
  const sessionID = ctx.extra?.agentClusterSessionID ?? promptOps?.agentClusterSessionID
  return typeof sessionID === "string" ? (sessionID as SessionID) : undefined
}

function nonEmpty(value: string | undefined) {
  return typeof value === "string" && value.trim().length > 0
}

function formatOutput(lines: string[]) {
  return ["<agent_cluster_review>", ...lines, "</agent_cluster_review>"].join("\n")
}

export const AgentClusterReviewTool = Tool.define(
  "agent_cluster_review",
  Effect.gen(function* () {
    const config = yield* Config.Service
    const sessions = yield* Session.Service
    const fsys = yield* AppFileSystem.Service

    const run = Effect.fn("AgentClusterReviewTool.execute")(function* (
      params: Schema.Schema.Type<typeof Parameters>,
      ctx: Tool.Context,
    ) {
      if (ctx.agent !== "cluster") {
        return yield* Effect.fail(new Error("agent_cluster_review is only available to the cluster primary agent"))
      }

      const sessionID = agentClusterSessionID(ctx)
      if (!sessionID) {
        return yield* Effect.fail(
          new Error(
            "Agent cluster session task graph not found. The review tool must be called within an active cluster session. " +
              "If you are reviewing tasks from a plan, make sure the plan was persisted by dispatching tasks with valid task_id values first.",
          ),
        )
      }
      const state = yield* WorkflowExecutor.getMultiSessionState(sessionID)
      const matches = state.tasks.filter((task) => task.id === params.task_id || task.child_session_id === params.task_id)
      if (matches.length !== 1) {
        const knownIDs = state.tasks.map((task) => `${task.id}(status=${task.status})`).join(", ")
        return yield* Effect.fail(
          new Error(
            matches.length === 0
              ? `Workflow task not found in session ${sessionID}: ${params.task_id}. Known task IDs: [${knownIDs || "(none)"}]. Use the exact plan task id.`
              : `Workflow task id is ambiguous: ${params.task_id} matches ${matches.length} tasks in session ${sessionID}.`,
          ),
        )
      }
      const task = matches[0]!
      if (task.status !== "submitted" && task.status !== "reviewing") {
        return yield* Effect.fail(new Error(`Workflow task ${task.id} cannot be reviewed from status ${task.status}`))
      }

      // NOTE: every validation below runs BEFORE any status mutation. A rejected
      // review must leave the task in its prior (retryable) status — previously the
      // task was moved to "reviewing" first and a failed validation stranded it there.
      const cfg = ConfigAgentCluster.resolve((yield* config.get()).agent_cluster)
      const issues = params.issues.filter((issue) => issue.trim())
      if (params.decision === "accepted") {
        // Count-based acceptance: every plan criterion must have at least one
        // corresponding check with passed=true and concrete evidence.  Text
        // matching is inherently fragile — LLMs rephrase criteria in minor
        // ways (function vs physics, counts vs inequalities).  Instead we
        // simply require that all checks pass, that every check has evidence,
        // and that there are not fewer checks than plan criteria.
        const allPassed = params.checks.every((c) => c.passed === true && nonEmpty(c.evidence))
        if (!allPassed) {
          const failing = params.checks
            .filter((c) => !c.passed || !nonEmpty(c.evidence))
            .map((c) => c.criterion)
            .join(", ")
          return yield* Effect.fail(
            new Error(
              `Cannot accept task ${task.id}; some checks failed or have no evidence: [${failing}]. ` +
                `All ${params.checks.length} checks must pass with concrete evidence.`,
            ),
          )
        }
        if (params.checks.length < task.acceptance_criteria.length) {
          return yield* Effect.fail(
            new Error(
              `Cannot accept task ${task.id}; ` +
                `got ${params.checks.length} checks but need at least ${task.acceptance_criteria.length} ` +
                `(one per acceptance criterion). Criteria: [${task.acceptance_criteria.join(" | ")}].`,
            ),
          )
        }
        const session = yield* sessions.get(sessionID).pipe(Effect.orDie)
        const missingArtifacts: string[] = []
        for (const artifact of task.artifact_paths) {
          const artifactPath = path.isAbsolute(artifact) ? artifact : path.resolve(session.directory, artifact)
          if (!(yield* fsys.existsSafe(artifactPath))) missingArtifacts.push(artifact)
        }
        if (missingArtifacts.length > 0) {
          return yield* Effect.fail(
            new Error(`Cannot accept task ${task.id}; missing artifact(s): ${missingArtifacts.join(", ")}`),
          )
        }
      }

      let status: "accepted" | "revision_requested" | "failed" = params.decision
      let reviewRound = (yield* WorkflowCollaboration.listReviewFindings(sessionID)).filter(
        (finding) => finding.nodeID === NodeID.make(task.id),
      ).length
      let outputLines: string[]
      if (params.decision === "revision_requested") {
        if (issues.length === 0) {
          return yield* Effect.fail(new Error("revision_requested requires at least one concrete issue"))
        }
        if (!nonEmpty(params.revision_prompt)) {
          return yield* Effect.fail(new Error("revision_requested requires revision_prompt"))
        }
        reviewRound += 1
        status = reviewRound >= cfg.max_review_rounds ? "failed" : "revision_requested"
        outputLines =
          status === "failed"
            ? [
                `task_id: ${task.id}`,
                "decision: failed",
                `review_round: ${reviewRound}`,
                "next_action: stop; maximum review rounds reached",
              ]
            : [
                `task_id: ${task.id}`,
                "decision: revision_requested",
                `review_round: ${reviewRound}`,
                `next_action: call task with task_id=${task.child_session_id ?? task.id} to resume the same subagent`,
                `revision_prompt: ${params.revision_prompt!.trim()}`,
              ]
      } else if (params.decision === "failed" && issues.length === 0) {
        return yield* Effect.fail(new Error("failed requires at least one concrete issue"))
      } else {
        outputLines = [
          `task_id: ${task.id}`,
          `decision: ${params.decision}`,
          `review_round: ${reviewRound}`,
          params.decision === "accepted"
            ? "next_action: wait for remaining tasks in this step, or dispatch the next step if all are accepted"
            : "next_action: stop; this run has failed",
        ]
      }

      const runtimePlan = yield* WorkflowRuntime.getSessionRunPlan(sessionID)
      const nodeID = NodeID.make(task.id)
      const runtimeTask = runtimePlan.tasks.find((item) => item.id === nodeID)
      if (!runtimeTask) return yield* Effect.fail(new Error(`Workflow node disappeared: ${task.id}`))
      if (runtimeTask.status === "submitted") {
        yield* WorkflowRuntime.transitionNode({ sessionID, runPlanID: runtimePlan.id, nodeID, from: "submitted", to: "reviewing" })
      }
      if (status === "accepted") {
        yield* WorkflowRuntime.transitionNode({
          sessionID,
          runPlanID: runtimePlan.id,
          nodeID,
          from: "reviewing",
          to: "accepted",
          detail: { validation: true, evidence: params.checks.filter((check) => check.passed).map((check) => check.evidence) },
        })
      } else {
        yield* WorkflowCollaboration.createReviewFinding({
          sessionID,
          runPlanID: runtimePlan.id,
          nodeID,
          authorAgentID: "reviewer",
          severity: status === "failed" ? "high" : "medium",
          summary: `Review requested changes for ${task.title}`,
          evidence: [...issues],
          suggestion: params.revision_prompt?.trim() || issues.join("\n") || "Investigate the failed validation.",
        })
        yield* WorkflowRuntime.transitionNode({ sessionID, runPlanID: runtimePlan.id, nodeID, from: "reviewing", to: "revision_requested", detail: { issues } })
        if (status === "failed") {
          yield* WorkflowRuntime.transitionNode({ sessionID, runPlanID: runtimePlan.id, nodeID, from: "revision_requested", to: "revising" })
          yield* WorkflowRuntime.transitionNode({ sessionID, runPlanID: runtimePlan.id, nodeID, from: "revising", to: "failed", detail: { issues } })
        }
      }

      return {
        title: "Workflow review",
        metadata: {
          task_id: task.id,
          decision: params.decision,
          status,
          review_round: reviewRound,
        },
        output: formatOutput(outputLines),
      }
    })

    return {
      description: DESCRIPTION,
      parameters: Parameters,
      catalog: {
        category: "subagent",
        mutability: "write",
        risk: "medium",
        detail: "core",
      },
      execute: (params: Schema.Schema.Type<typeof Parameters>, ctx: Tool.Context) =>
        run(params, ctx).pipe(Effect.orDie),
    }
  }),
)
