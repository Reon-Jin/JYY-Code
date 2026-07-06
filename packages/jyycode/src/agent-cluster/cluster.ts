export * as AgentCluster from "./cluster"

import { ConfigAgentCluster } from "@/config/agent-cluster"
import { MailSession } from "@/communication/mail-session"
import { Provider } from "@/provider/provider"
import { ModelID, ProviderID } from "@/provider/schema"
import type { Session } from "@/session/session"
import type { MessageV2 } from "@/session/message-v2"
import type { PromptInput } from "@/session/prompt"
import type { SessionID } from "@/session/schema"
import { Bus } from "@/bus"
import * as Database from "@/storage/db"
import { and, eq, inArray, or } from "@/storage/db"
import { Cause, Effect } from "effect"
import path from "path"
import { ulid } from "ulid"
import { AgentClusterRunTable, AgentClusterEventTable, AgentClusterTaskTable } from "./cluster.sql"
import { Event } from "./event"
import { runInstructions } from "./planner"
import { buildTaskBrief } from "./dispatcher"
import { stepGate } from "./runtime"
import type { Plan, PlannedTask, RunID, RunStatus, TaskID, TaskStatus } from "./schema"

type ModelRef = {
  providerID: ProviderID
  modelID: ModelID
}

type ClusterModels = {
  planner: ModelRef
  simple: ModelRef
  complex: ModelRef
  visual: ModelRef
}

type TaskRow = typeof AgentClusterTaskTable.$inferSelect

export function isMailSession(session: Pick<Session.Info, "title" | "agent" | "path">) {
  if (MailSession.isMailSessionTitle(session.title)) return true
  if (session.agent === "mail") return true
  return session.path === "mail"
}

export function createRunID() {
  return ulid()
}

export function canUseAgentCluster(input: {
  session: Pick<Session.Info, "title" | "agent" | "path" | "multiAgent" | "parentID">
  config: ConfigAgentCluster.Info | undefined
  requested?: boolean
}) {
  const config = ConfigAgentCluster.resolve(input.config)
  if (config.enabled !== true) return false
  if (isMailSession(input.session)) return false
  if (input.session.parentID) return false
  return (input.requested ?? input.session.multiAgent ?? config.default_on) === true
}

export const resolveModelRef = Effect.fn("AgentCluster.resolveModelRef")(function* (model: string) {
  const provider = yield* Provider.Service
  if (model.includes("/")) {
    const parsed = Provider.parseModel(model)
    yield* provider.getModel(parsed.providerID, parsed.modelID)
    return parsed
  }

  const providers = yield* provider.list()
  const matches = Object.values(providers)
    .filter((item) => item.models[model])
    .map((item) => ({ providerID: item.id, modelID: ModelID.make(model) }))
  if (matches.length === 1) return matches[0]!
  if (matches.length > 1) {
    return yield* Effect.fail(new Error(`Agent cluster model "${model}" is ambiguous; use provider/${model}`))
  }
  return yield* Effect.fail(new Error(`Agent cluster model not found: ${model}`))
})

export const resolveModels = Effect.fn("AgentCluster.resolveModels")(function* (config: ConfigAgentCluster.Info) {
  const resolved = ConfigAgentCluster.resolve(config)
  return yield* Effect.all(
    {
      planner: resolveModelRef(resolved.planner_model),
      simple: resolveModelRef(resolved.simple_model),
      complex: resolveModelRef(resolved.complex_model),
      visual: resolveModelRef(resolved.visual_model),
    },
    { concurrency: "unbounded" },
  )
})

export function formatModel(model: ModelRef) {
  return `${model.providerID}/${model.modelID}`
}

export function artifactDir(input: { session: Pick<Session.Info, "directory">; config: ConfigAgentCluster.Info }) {
  const config = ConfigAgentCluster.resolve(input.config)
  if (path.isAbsolute(config.artifact_dir)) return config.artifact_dir
  return path.join(input.session.directory, config.artifact_dir)
}

export function decoratePromptInput(input: {
  prompt: PromptInput
  runID: string
  session: Pick<Session.Info, "directory">
  config: ConfigAgentCluster.Info
  models: ClusterModels
}): PromptInput {
  const config = ConfigAgentCluster.resolve(input.config)
  return {
    ...input.prompt,
    agent: "cluster",
    model: input.models.planner,
    parts: [
      ...input.prompt.parts,
      {
        type: "text" as const,
        synthetic: true,
        text: runInstructions({
          runID: input.runID,
          artifactDir: artifactDir({ session: input.session, config }),
          simpleModel: formatModel(input.models.simple),
          complexModel: formatModel(input.models.complex),
          visualModel: formatModel(input.models.visual),
          maxSubagents: config.max_subagents,
          maxConcurrency: config.max_concurrency,
          maxReviewRounds: config.max_review_rounds,
        }),
        metadata: {
          kind: "agent_cluster",
          runID: input.runID,
        },
      },
    ],
  }
}

export const persistPlan = Effect.fn("AgentCluster.persistPlan")(function* (input: { runID: RunID; plan: Plan }) {
  const now = Date.now()
  yield* Database.query((db) =>
    db
      .insert(AgentClusterTaskTable)
      .values(
        input.plan.tasks.map((task) => ({
          id: task.id,
          run_id: input.runID,
          role: task.role,
          title: task.title,
          prompt: task.prompt,
          complexity: task.complexity,
          model: task.model,
          status: "planned" as const,
          step: task.step,
          dependencies: [...task.dependencies],
          acceptance_criteria: [...task.acceptanceCriteria],
          artifact_paths: [...task.expectedArtifacts],
          review_issues: [],
          time_created: now,
          time_updated: now,
        })),
      )
      .onConflictDoNothing()
      .run(),
  )
})

export const markTaskRunning = Effect.fn("AgentCluster.markTaskRunning")(function* (input: {
  runID?: string
  taskID?: string
  childSessionID: SessionID
}) {
  if (!input.runID || !input.taskID) return
  const current = (yield* Database.query((db) =>
    db
      .select({ status: AgentClusterTaskTable.status })
      .from(AgentClusterTaskTable)
      .where(
        and(
          eq(AgentClusterTaskTable.run_id, input.runID as RunID),
          eq(AgentClusterTaskTable.id, input.taskID as TaskID),
        ),
      )
      .get(),
  )) as { status: TaskStatus } | undefined
  yield* Database.query((db) =>
    db
      .update(AgentClusterTaskTable)
      .set({
        child_session_id: input.childSessionID,
        status: current?.status === "revising" ? ("revising" as const) : ("running" as const),
        time_updated: Date.now(),
      })
      .where(
        and(
          eq(AgentClusterTaskTable.run_id, input.runID as RunID),
          eq(AgentClusterTaskTable.id, input.taskID as TaskID),
        ),
      )
      .run(),
  )
})

export const submitTaskResult = Effect.fn("AgentCluster.submitTaskResult")(function* (input: {
  runID?: string
  taskID?: string
  childSessionID: SessionID
  summary: string
}) {
  if (!input.runID || !input.taskID) return
  yield* Database.query((db) =>
    db
      .update(AgentClusterTaskTable)
      .set({
        child_session_id: input.childSessionID,
        status: "submitted" as const,
        result_summary: input.summary,
        last_event: "submitted",
        time_updated: Date.now(),
      })
      .where(
        and(
          eq(AgentClusterTaskTable.run_id, input.runID as RunID),
          eq(AgentClusterTaskTable.id, input.taskID as TaskID),
        ),
      )
      .run(),
  )
})

export const failTaskResult = Effect.fn("AgentCluster.failTaskResult")(function* (input: {
  runID?: string
  taskID?: string
  childSessionID: SessionID
  error: string
}) {
  if (!input.runID || !input.taskID) return
  yield* Database.query((db) =>
    db
      .update(AgentClusterTaskTable)
      .set({
        child_session_id: input.childSessionID,
        status: "failed" as const,
        review_issues: [input.error],
        last_event: "failed",
        time_updated: Date.now(),
      })
      .where(
        and(
          eq(AgentClusterTaskTable.run_id, input.runID as RunID),
          eq(AgentClusterTaskTable.id, input.taskID as TaskID),
        ),
      )
      .run(),
  )
  yield* finishRunFromTaskStates(input.runID as RunID)
})

export const finishRunFromTaskStates = Effect.fn("AgentCluster.finishRunFromTaskStates")(function* (runID: RunID) {
  const tasks = (yield* Database.query((db) =>
    db.select().from(AgentClusterTaskTable).where(eq(AgentClusterTaskTable.run_id, runID)).all(),
  )) as TaskRow[]
  const now = Date.now()
  const status: "open" | "completed" | "failed" = tasks.some(
    (task) => task.status === "failed" || task.status === "cancelled",
  )
    ? "failed"
    : tasks.length > 0 && tasks.every((task) => task.status === "accepted")
      ? "completed"
      : "open"

  if (status === "open") return status

  yield* Database.query((db) =>
    db
      .update(AgentClusterRunTable)
      .set({ status, completed_at: now, time_updated: now })
      .where(eq(AgentClusterRunTable.id, runID))
      .run(),
  )
  return status
})

export const finalizeRunIfTerminal = Effect.fn("AgentCluster.finalizeRunIfTerminal")(function* (runID: RunID) {
  return (yield* finishRunFromTaskStates(runID)) === "completed"
})

function plannedTaskFromRow(row: TaskRow): PlannedTask {
  return {
    id: row.id,
    step: row.step,
    title: row.title,
    role: row.role,
    complexity: row.complexity,
    model: row.model,
    dependencies: row.dependencies.map((item) => item as TaskID),
    prompt: row.prompt,
    acceptanceCriteria: row.acceptance_criteria,
    expectedArtifacts: row.artifact_paths,
  }
}

function extractSummary(text: string) {
  const match = text.match(/^\*\*Summary\*\*:\s*(.+)$/im)
  const summary = match?.[1]?.trim()
  if (summary) return summary.slice(0, 1000)
  return text.replace(/\s+/g, " ").trim().slice(0, 1000) || "(no summary returned)"
}

export function summarizeTaskResult(text: string) {
  return extractSummary(text)
}

export const prepareTaskDispatch = Effect.fn("AgentCluster.prepareTaskDispatch")(function* (input: {
  runID?: string
  requestedTaskID?: string
  prompt: string
}) {
  if (!input.runID || !input.requestedTaskID) {
    return {
      prompt: input.prompt,
      taskID: undefined as TaskID | undefined,
      childSessionID: undefined as SessionID | undefined,
    }
  }
  const runID = input.runID as RunID
  const rows = (yield* Database.query((db) =>
    db.select().from(AgentClusterTaskTable).where(eq(AgentClusterTaskTable.run_id, runID)).all(),
  )) as TaskRow[]
  const target = rows.find((row) => row.id === input.requestedTaskID || row.child_session_id === input.requestedTaskID)
  if (!target) {
    return yield* Effect.fail(new Error(`Unknown cluster task for run ${runID}: ${input.requestedTaskID}`))
  }
  if (target.status === "failed" || target.status === "cancelled" || target.status === "accepted") {
    return yield* Effect.fail(new Error(`Cluster task ${target.id} cannot be dispatched from status ${target.status}`))
  }
  const isRevision = target.child_session_id === input.requestedTaskID || target.status === "revision_requested"
  if (!isRevision) {
    const gate = stepGate(rows, target.step)
    if (!gate.allowed) {
      return yield* Effect.fail(
        new Error(
          [
            "Step gate blocked: all tasks in earlier steps must be accepted",
            gate.pending.length ? `pending: ${gate.pending.join(", ")}` : undefined,
            gate.rejected.length ? `rejected: ${gate.rejected.join(", ")}` : undefined,
          ]
            .filter(Boolean)
            .join("; "),
        ),
      )
    }
  }

  const task = plannedTaskFromRow(target)
  const tasks = rows.map(plannedTaskFromRow)
  const predecessors = rows
    .filter(
      (row) => row.step < target.step && (target.dependencies.length === 0 || target.dependencies.includes(row.id)),
    )
    .map((row) => ({
      ...plannedTaskFromRow(row),
      status: row.status as TaskStatus,
      resultSummary: row.result_summary,
    }))
  const peers = tasks.filter((item) => item.step === task.step && item.id !== task.id)
  const consumers = tasks.filter((item) => item.dependencies.includes(task.id))
  const brief = buildTaskBrief({
    goal:
      (
        (yield* Database.query((db) =>
          db
            .select({ goal: AgentClusterRunTable.goal })
            .from(AgentClusterRunTable)
            .where(eq(AgentClusterRunTable.id, runID))
            .get(),
        )) as { goal: string } | undefined
      )?.goal ?? "Multi-Agent cluster run",
    task,
    peers,
    predecessors,
    consumers,
    reviewIssues: target.review_issues,
  })
  const prompt = [brief, "", input.prompt].join("\n")
  if (target.status === "revision_requested") {
    yield* Database.query((db) =>
      db
        .update(AgentClusterTaskTable)
        .set({ status: "revising" as const, time_updated: Date.now() })
        .where(and(eq(AgentClusterTaskTable.run_id, runID), eq(AgentClusterTaskTable.id, target.id)))
        .run(),
    )
  }
  return {
    prompt,
    taskID: target.id,
    childSessionID: target.child_session_id ?? undefined,
  }
})

export const getSessionState = Effect.fn("AgentCluster.getSessionState")(function* (sessionID: SessionID) {
  return yield* Database.query((db) =>
    Effect.gen(function* () {
      const runs = (yield* db
        .select()
        .from(AgentClusterRunTable)
        .where(eq(AgentClusterRunTable.session_id, sessionID))
        .all()) as (typeof AgentClusterRunTable.$inferSelect)[]
      const tasks =
        runs.length === 0
          ? []
          : ((yield* db
              .select()
              .from(AgentClusterTaskTable)
              .where(
                inArray(
                  AgentClusterTaskTable.run_id,
                  runs.map((run) => run.id),
                ),
              )
              .all()) as TaskRow[])
      return { runs, tasks }
    }),
  )
})

export const run = Effect.fn("AgentCluster.run")(function* (input: {
  runID: string
  session: Session.Info
  message: MessageV2.WithParts
  config: ConfigAgentCluster.Info
  models: ClusterModels
  runLoop: Effect.Effect<MessageV2.WithParts>
}) {
  const bus = yield* Bus.Service
  const runID = input.runID as RunID
  const publish = (status: RunStatus, message: string) =>
    Effect.gen(function* () {
      const createdAt = Date.now()
      yield* Database.query((db) =>
        db
          .insert(AgentClusterEventTable)
          .values({
            id: ulid(),
            run_id: runID,
            type: "run",
            message,
            metadata: { status },
          })
          .run(),
      )
      yield* bus.publish(Event, {
        sessionID: input.session.id,
        runID,
        type: "run",
        status,
        message,
        createdAt,
      })
    })

  const publishReview = (taskID: string, decision: string, issues: string) =>
    Effect.gen(function* () {
      const createdAt = Date.now()
      yield* Database.query((db) =>
        db
          .insert(AgentClusterEventTable)
          .values({
            id: ulid(),
            run_id: runID,
            type: "review",
            message: `Review for task ${taskID}: ${decision}`,
            metadata: {
              status: "reviewing",
              taskID,
              decision,
              issues,
            },
          })
          .run(),
      )
      yield* bus.publish(Event, {
        sessionID: input.session.id,
        runID,
        type: "review",
        status: "reviewing",
        taskID: taskID as any,
        message: `Review for task ${taskID}: ${decision}`,
        metadata: { taskID, decision, issues },
        createdAt,
      })
    })

  const now = Date.now()
  yield* Database.query((db) =>
    db
      .insert(AgentClusterRunTable)
      .values({
        id: runID,
        session_id: input.session.id,
        parent_message_id: input.message.info.id,
        enabled: true,
        status: "planning",
        goal:
          input.message.parts
            .flatMap((part) => (part.type === "text" && !part.synthetic ? [part.text] : []))
            .join("\n")
            .slice(0, 2000) || "Multi-Agent cluster run",
        planner_model: formatModel(input.models.planner),
        // Legacy storage column retained for database compatibility. Review is
        // performed by the cluster primary, so no separate model is routed.
        reviewer_model: formatModel(input.models.planner),
        time_created: now,
        time_updated: now,
      })
      .run(),
  )
  yield* publish("planning", "main: planning")

  return yield* input.runLoop.pipe(
    Effect.tap(() =>
      finishRunFromTaskStates(runID).pipe(
        Effect.andThen((status) =>
          status === "completed"
            ? publish("completed", "main: completed")
            : status === "failed"
              ? publish("failed", "main: failed")
              : Effect.void,
        ),
      ),
    ),
    Effect.catchCause((cause) =>
      Database.query((db) =>
        db
          .update(AgentClusterRunTable)
          .set({ status: "failed", completed_at: Date.now(), time_updated: Date.now() })
          .where(eq(AgentClusterRunTable.id, runID))
          .run(),
      ).pipe(Effect.andThen(publish("failed", Cause.pretty(cause))), Effect.andThen(Effect.failCause(cause))),
    ),
  )
})
