import * as Tool from "./tool"
import DESCRIPTION from "./agent-cluster-review.txt"
import { AgentCluster } from "@/agent-cluster/cluster"
import { Event as AgentClusterEvent } from "@/agent-cluster/event"
import { Bus } from "@/bus"
import { AgentClusterEventTable, AgentClusterTaskTable } from "@/agent-cluster/cluster.sql"
import { Config } from "@/config/config"
import { ConfigAgentCluster } from "@/config/agent-cluster"
import { Session } from "@/session/session"
import { SessionID } from "@/session/schema"
import { AppFileSystem } from "@jyycode-ai/core/filesystem"
import * as Database from "@/storage/db"
import { and, eq } from "@/storage/db"
import path from "path"
import { ulid } from "ulid"
import { Effect, Schema } from "effect"
import type { TaskStatus } from "@/agent-cluster/schema"

type TaskRow = typeof AgentClusterTaskTable.$inferSelect

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
    const bus = yield* Bus.Service

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
      const rows = (yield* Database.query((db) =>
        db.select().from(AgentClusterTaskTable).where(eq(AgentClusterTaskTable.session_id, sessionID)).all(),
      )) as TaskRow[]
      const matches = rows.filter((row) => row.id === params.task_id || row.child_session_id === params.task_id)
      if (matches.length !== 1) {
        const knownIDs = rows.map((r) => `${r.id}(status=${r.status})`).join(", ")
        return yield* Effect.fail(
          new Error(
            matches.length === 0
              ? `Cluster task not found in session ${sessionID}: ${params.task_id}. Known task IDs: [${knownIDs || "(none)"}]. Use the exact plan task id.`
              : `Cluster task id is ambiguous: ${params.task_id} matches ${matches.length} tasks in session ${sessionID}.`,
          ),
        )
      }
      const task = matches[0]!
      if (task.status !== "submitted" && task.status !== "reviewing") {
        return yield* Effect.fail(new Error(`Cluster task ${task.id} cannot be reviewed from status ${task.status}`))
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

      let status: TaskStatus = params.decision
      let reviewRound = task.review_round
      let outputLines: string[]
      if (params.decision === "revision_requested") {
        if (issues.length === 0) {
          return yield* Effect.fail(new Error("revision_requested requires at least one concrete issue"))
        }
        if (!nonEmpty(params.revision_prompt)) {
          return yield* Effect.fail(new Error("revision_requested requires revision_prompt"))
        }
        reviewRound = task.review_round + 1
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
                `next_action: call task with task_id=${task.child_session_id} to resume the same subagent`,
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

      yield* Database.query((db) =>
        db
          .update(AgentClusterTaskTable)
          .set({
            status,
            review_round: reviewRound,
            review_issues: status === "accepted" ? [] : issues,
            last_event: params.decision,
            time_updated: Date.now(),
          })
          .where(and(eq(AgentClusterTaskTable.session_id, sessionID), eq(AgentClusterTaskTable.id, task.id)))
          .run(),
      )
      yield* Database.query((db) =>
        db
          .insert(AgentClusterEventTable)
          .values({
            id: ulid(),
            session_id: sessionID,
            origin_message_id: task.origin_message_id,
            task_id: task.id,
            type: "review",
            message: `Review for task ${task.id}: ${status}`,
            metadata: {
              decision: params.decision,
              status,
              checks: params.checks,
              issues,
              reviewRound,
            },
            time_created: Date.now(),
            time_updated: Date.now(),
          })
          .run(),
      )
      yield* bus.publish(AgentClusterEvent, {
        sessionID,
        taskID: task.id,
        type: "review",
        status,
        message: `Review for task ${task.id}: ${status}`,
        metadata: {
          decision: params.decision,
          checks: params.checks,
          issues,
          reviewRound,
        },
        createdAt: Date.now(),
      })

      return {
        title: "Agent cluster review",
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
