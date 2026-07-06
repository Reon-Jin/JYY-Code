import * as Tool from "./tool"
import DESCRIPTION from "./agent-cluster-review.txt"
import { AgentCluster } from "@/agent-cluster/cluster"
import { Event as AgentClusterEvent } from "@/agent-cluster/event"
import { Bus } from "@/bus"
import { AgentClusterEventTable, AgentClusterRunTable, AgentClusterTaskTable } from "@/agent-cluster/cluster.sql"
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
import type { RunID, TaskStatus } from "@/agent-cluster/schema"

type TaskRow = typeof AgentClusterTaskTable.$inferSelect
type RunRow = typeof AgentClusterRunTable.$inferSelect

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
    description: "One check per acceptance criterion, each with concrete evidence",
  }),
  issues: Schema.Array(Schema.String).annotate({
    description: "Specific unresolved issues. Required for revision_requested and failed.",
  }),
  revision_prompt: Schema.optional(Schema.String).annotate({
    description: "Concrete instructions for resuming the same child session when decision is revision_requested",
  }),
})

function agentClusterRunID(ctx: Tool.Context) {
  if (typeof ctx.extra?.agentClusterRunID === "string") return ctx.extra.agentClusterRunID
  for (const message of ctx.messages) {
    for (const part of message.parts) {
      const metadata = "metadata" in part ? (part.metadata as { kind?: string; runID?: string } | undefined) : undefined
      if (metadata?.kind === "agent_cluster" && metadata.runID) return metadata.runID
    }
  }
  return undefined
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

      const runID = agentClusterRunID(ctx) as RunID | undefined
      const rows = (yield* Database.query((db) =>
        runID
          ? db.select().from(AgentClusterTaskTable).where(eq(AgentClusterTaskTable.run_id, runID)).all()
          : db.select().from(AgentClusterTaskTable).all(),
      )) as TaskRow[]
      const matches = rows.filter((row) => row.id === params.task_id || row.child_session_id === params.task_id)
      if (matches.length !== 1) {
        return yield* Effect.fail(
          new Error(
            matches.length === 0
              ? `Cluster task not found: ${params.task_id}`
              : `Cluster task id is ambiguous without a run id: ${params.task_id}`,
          ),
        )
      }
      const task = matches[0]!
      if (task.status !== "submitted" && task.status !== "reviewing") {
        return yield* Effect.fail(new Error(`Cluster task ${task.id} cannot be reviewed from status ${task.status}`))
      }

      const now = Date.now()
      const clusterRun = (yield* Database.query((db) =>
        db.select().from(AgentClusterRunTable).where(eq(AgentClusterRunTable.id, task.run_id)).get(),
      )) as RunRow | undefined
      if (!clusterRun) return yield* Effect.fail(new Error(`Cluster run not found: ${task.run_id}`))
      if (task.status === "submitted") {
        yield* Database.query((db) =>
          db
            .update(AgentClusterTaskTable)
            .set({ status: "reviewing" as const, last_event: "reviewing", time_updated: now })
            .where(and(eq(AgentClusterTaskTable.run_id, task.run_id), eq(AgentClusterTaskTable.id, task.id)))
            .run(),
        )
      }

      const cfg = ConfigAgentCluster.resolve((yield* config.get()).agent_cluster)
      const issues = params.issues.filter((issue) => issue.trim())
      if (params.decision === "accepted") {
        const missing = task.acceptance_criteria.filter((criterion: string) => {
          const check = params.checks.find((item) => item.criterion === criterion)
          return !check || check.passed !== true || !nonEmpty(check.evidence)
        })
        if (missing.length > 0) {
          return yield* Effect.fail(
            new Error(`Cannot accept task ${task.id}; missing passing evidence for: ${missing.join(", ")}`),
          )
        }
        const session = yield* sessions.get(clusterRun.session_id).pipe(Effect.orDie)
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
          .where(and(eq(AgentClusterTaskTable.run_id, task.run_id), eq(AgentClusterTaskTable.id, task.id)))
          .run(),
      )
      yield* Database.query((db) =>
        db
          .insert(AgentClusterEventTable)
          .values({
            id: ulid(),
            run_id: task.run_id,
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
      if (status === "failed") {
        yield* Database.query((db) =>
          db
            .update(AgentClusterRunTable)
            .set({ status: "failed" as const, completed_at: Date.now(), time_updated: Date.now() })
            .where(eq(AgentClusterRunTable.id, task.run_id))
            .run(),
        )
      }
      if (status === "accepted") {
        yield* AgentCluster.finishRunFromTaskStates(task.run_id)
      }
      yield* bus.publish(AgentClusterEvent, {
        sessionID: clusterRun.session_id,
        runID: task.run_id,
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
