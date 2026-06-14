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
  Database.use((db) =>
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
          acceptance_criteria: [...task.acceptanceCriteria],
          artifact_paths: [...task.expectedArtifacts],
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
  Database.use((db) =>
    db
      .update(AgentClusterTaskTable)
      .set({
        child_session_id: input.childSessionID,
        status: "running",
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

export const finalizeRunIfTerminal = Effect.fn("AgentCluster.finalizeRunIfTerminal")(function* (runID: RunID) {
  const open = Database.use((db) =>
    db.select().from(AgentClusterTaskTable).where(eq(AgentClusterTaskTable.run_id, runID)).all(),
  ).filter((task) => !TERMINAL_TASK_STATUSES.includes(task.status as any))

  if (open.length > 0) return false

  Database.use((db) =>
    db
      .update(AgentClusterRunTable)
      .set({ status: "completed", completed_at: Date.now(), time_updated: Date.now() })
      .where(eq(AgentClusterRunTable.id, runID))
      .run(),
  )
  return true
})

export const getSessionState = Effect.fn("AgentCluster.getSessionState")(function* (sessionID: SessionID) {
  return Database.use((db) => {
    const runs = db.select().from(AgentClusterRunTable).where(eq(AgentClusterRunTable.session_id, sessionID)).all()
    const tasks =
      runs.length === 0
        ? []
        : db
            .select()
            .from(AgentClusterTaskTable)
            .where(inArray(AgentClusterTaskTable.run_id, runs.map((run) => run.id)))
            .all()
    return { runs, tasks }
  })
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
      Database.use((db) =>
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
      Database.use((db) =>
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
  Database.use((db) =>
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
  yield* publish("planning", "main: planning")

  return yield* input.runLoop.pipe(
    Effect.tap(() =>
      finalizeRunIfTerminal(runID).pipe(
        Effect.andThen((completed) => (completed ? publish("completed", "main: completed") : Effect.void)),
      ),
    ),
    Effect.catchCause((cause) =>
      Effect.sync(() =>
        Database.use((db) =>
          db
            .update(AgentClusterRunTable)
            .set({ status: "failed", completed_at: Date.now(), time_updated: Date.now() })
            .where(eq(AgentClusterRunTable.id, runID))
            .run(),
        ),
      ).pipe(Effect.andThen(publish("failed", Cause.pretty(cause))), Effect.andThen(Effect.failCause(cause))),
    ),
  )
})
