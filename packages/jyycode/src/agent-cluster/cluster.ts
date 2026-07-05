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
import { and, eq, inArray } from "@/storage/db"
import { Cause, Effect } from "effect"
import path from "path"
import { ulid } from "ulid"
import { AgentClusterRunTable, AgentClusterEventTable, AgentClusterTaskTable } from "./cluster.sql"
import { Event } from "./event"
import { runInstructions } from "./planner"
import { AgentClusterLifecycle } from "./lifecycle"
import type { Plan, RunID, RunStatus, TaskID } from "./schema"

type ModelRef = {
  providerID: ProviderID
  modelID: ModelID
}

type ClusterModels = {
  planner: ModelRef
  reviewer: ModelRef
  simple: ModelRef
  complex: ModelRef
  visual: ModelRef
}

const TERMINAL_TASK_STATUSES = ["accepted", "failed", "cancelled"] as const

export function isMailSession(session: Pick<Session.Info, "title" | "agent" | "path">) {
  if (MailSession.isMailSessionTitle(session.title)) return true
  if (session.agent === "mail") return true
  return session.path === "mail"
}

export function createRunID() {
  return ulid()
}

export function canUseAgentCluster(input: {
  session: Pick<Session.Info, "title" | "agent" | "path" | "multiAgent">
  config: ConfigAgentCluster.Info | undefined
  requested?: boolean
}) {
  const config = ConfigAgentCluster.resolve(input.config)
  if (config.enabled !== true) return false
  if (isMailSession(input.session)) return false
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
      reviewer: resolveModelRef(resolved.reviewer_model),
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
          reviewerModel: formatModel(input.models.reviewer),
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
          id: ulid(),
          run_id: input.runID,
          plan_task_id: task.id,
          step: task.step,
          dependencies: [...task.dependencies],
          role: task.role,
          title: task.title,
          prompt: task.prompt,
          complexity: task.complexity,
          model: task.model,
          status: "planned" as const,
          status_version: 0,
          acceptance_criteria: [...task.acceptanceCriteria],
          artifact_paths: [...task.expectedArtifacts],
          time_created: now,
          time_updated: now,
        })),
      )
      .run(),
  )
})

export const markTaskRunning = Effect.fn("AgentCluster.markTaskRunning")(function* (input: {
  runID?: string
  planTaskID?: string
  childSessionID: SessionID
}) {
  if (!input.runID || !input.planTaskID) return
  yield* Database.query((db) =>
    db
      .update(AgentClusterTaskTable)
      .set({
        child_session_id: input.childSessionID,
        status: "running",
        status_version: Database.sql`${AgentClusterTaskTable.status_version} + 1`,
        time_updated: Date.now(),
      })
      .where(
        and(
          eq(AgentClusterTaskTable.run_id, input.runID as RunID),
          eq(AgentClusterTaskTable.plan_task_id, input.planTaskID),
        ),
      )
      .run(),
  )
})

export type TaskTransitionPatch = {
  result_text?: string
  child_session_id?: string
  review_issues?: string[]
  revision_prompt?: string | null
  artifact_paths?: string[]
  last_event?: string
  submitted_at?: number
  accepted_at?: number
}

export const transitionTask = Effect.fn("AgentCluster.transitionTask")(function* (input: {
  runID: RunID
  taskID: TaskID
  from: readonly TaskStatus[]
  to: TaskStatus
  expectedVersion?: number
  message: string
  patch?: Partial<TaskTransitionPatch>
}) {
  const now = Date.now()
  yield* Database.withTransaction((tx) =>
    Effect.gen(function* () {
      const row = yield* tx
        .select()
        .from(AgentClusterTaskTable)
        .where(
          and(
            eq(AgentClusterTaskTable.run_id, input.runID),
            eq(AgentClusterTaskTable.id, input.taskID),
          ),
        )
        .get()

      if (!row) {
        return yield* Effect.fail(
          new Error(`Task ${input.taskID} not found in run ${input.runID}`),
        )
      }

      if (!(input.from as readonly string[]).includes(row.status)) {
        return yield* Effect.fail(
          new Error(
            `Task ${input.taskID} is ${row.status}, expected one of [${input.from.join(", ")}]`,
          ),
        )
      }

      if (input.expectedVersion !== undefined && row.status_version !== input.expectedVersion) {
        return yield* Effect.fail(
          new Error(
            `Version mismatch for task ${input.taskID}: expected ${input.expectedVersion}, got ${row.status_version}`,
          ),
        )
      }

      const newVersion = row.status_version + 1
      const set: Record<string, unknown> = {
        status: input.to,
        status_version: newVersion,
        last_event: input.message,
        time_updated: now,
      }
      if (input.patch) {
        for (const [key, value] of Object.entries(input.patch)) {
          if (value !== undefined) set[key] = value
        }
      }

      yield* tx
        .update(AgentClusterTaskTable)
        .set(set)
        .where(
          and(
            eq(AgentClusterTaskTable.run_id, input.runID),
            eq(AgentClusterTaskTable.id, input.taskID),
            eq(AgentClusterTaskTable.status_version, row.status_version),
          ),
        )
        .run()

      yield* tx
        .insert(AgentClusterEventTable)
        .values({
          id: ulid(),
          run_id: input.runID,
          task_id: input.taskID,
          type: "task",
          message: input.message,
          metadata: { from: row.status, to: input.to, version: newVersion },
        })
        .run()
    }),
  )
})

export const transitionRun = Effect.fn("AgentCluster.transitionRun")(function* (input: {
  runID: RunID
  from: readonly RunStatus[]
  to: RunStatus
  expectedVersion?: number
  message: string
}) {
  const now = Date.now()
  yield* Database.withTransaction((tx) =>
    Effect.gen(function* () {
      const row = yield* tx
        .select()
        .from(AgentClusterRunTable)
        .where(eq(AgentClusterRunTable.id, input.runID))
        .get()

      if (!row) {
        return yield* Effect.fail(new Error(`Run ${input.runID} not found`))
      }

      if (!(input.from as readonly string[]).includes(row.status)) {
        return yield* Effect.fail(
          new Error(`Run ${input.runID} is ${row.status}, expected one of [${input.from.join(", ")}]`),
        )
      }

      if (input.expectedVersion !== undefined && row.status_version !== input.expectedVersion) {
        return yield* Effect.fail(
          new Error(
            `Version mismatch for run ${input.runID}: expected ${input.expectedVersion}, got ${row.status_version}`,
          ),
        )
      }

      const newVersion = row.status_version + 1
      const set: Record<string, unknown> = {
        status: input.to,
        status_version: newVersion,
        time_updated: now,
      }
      if (input.to === "completed" || input.to === "failed" || input.to === "cancelled") {
        set.completed_at = now
      }

      yield* tx
        .update(AgentClusterRunTable)
        .set(set)
        .where(
          and(
            eq(AgentClusterRunTable.id, input.runID),
            eq(AgentClusterRunTable.status_version, row.status_version),
          ),
        )
        .run()

      yield* tx
        .insert(AgentClusterEventTable)
        .values({
          id: ulid(),
          run_id: input.runID,
          type: "run",
          message: input.message,
          metadata: { from: row.status, to: input.to, version: newVersion },
        })
        .run()
    }),
  )
})

export const finalizeRunIfTerminal = Effect.fn("AgentCluster.finalizeRunIfTerminal")(function* (runID: RunID) {
  const run = yield* Database.query((db) =>
    db.select().from(AgentClusterRunTable).where(eq(AgentClusterRunTable.id, runID)).get(),
  )

  if (!run) return false

  // Never auto-complete a planning run — it has no tasks yet
  if (run.status === "planning") return false

  const tasks = yield* Database.query((db) =>
    db.select().from(AgentClusterTaskTable).where(eq(AgentClusterTaskTable.run_id, runID)).all(),
  )

  // Must have at least one task to consider completion
  if (tasks.length === 0) return false

  const open = tasks.filter((task) => !TERMINAL_TASK_STATUSES.includes(task.status as any))
  if (open.length > 0) return false

  // All tasks terminal — derive status from lifecycle
  const statuses = tasks.map((t) => t.status as import("./schema").TaskStatus)
  const derived = AgentClusterLifecycle.deriveRunStatus(statuses)
  const now = Date.now()

  yield* Database.query((db) =>
    db
      .update(AgentClusterRunTable)
      .set({
        status: derived,
        completed_at: derived === "completed" || derived === "failed" ? now : undefined,
        time_updated: now,
      })
      .where(eq(AgentClusterRunTable.id, runID))
      .run(),
  )
  return true
})

export const getSessionState = Effect.fn("AgentCluster.getSessionState")(function* (sessionID: SessionID) {
  return yield* Database.query((db) =>
    Effect.gen(function* () {
      const runs = yield* db
        .select()
        .from(AgentClusterRunTable)
        .where(eq(AgentClusterRunTable.session_id, sessionID))
        .all()
      const tasks =
        runs.length === 0
          ? []
          : yield* db
              .select()
              .from(AgentClusterTaskTable)
              .where(
                inArray(
                  AgentClusterTaskTable.run_id,
                  runs.map((run) => run.id),
                ),
              )
              .all()
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
  const publish = (status: RunStatus, message: string, version: number) =>
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
        version,
        createdAt,
      })
    })

  const publishReview = (taskID: string, decision: string, issues: string, version: number) =>
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
        version,
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
        reviewer_model: formatModel(input.models.reviewer),
        time_created: now,
        time_updated: now,
      })
      .run(),
  )
  yield* publish("planning", "main: planning", 0)

  return yield* input.runLoop.pipe(
    Effect.tap(() =>
      finalizeRunIfTerminal(runID).pipe(
        Effect.andThen((completed) => (completed ? publish("completed", "main: completed", 1) : Effect.void)),
      ),
    ),
    Effect.catchCause((cause) =>
      Database.query((db) =>
        db
          .update(AgentClusterRunTable)
          .set({ status: "failed", completed_at: Date.now(), time_updated: Date.now() })
          .where(eq(AgentClusterRunTable.id, runID))
          .run(),
      ).pipe(Effect.andThen(publish("failed", Cause.pretty(cause), 1)), Effect.andThen(Effect.failCause(cause))),
    ),
  )
})
