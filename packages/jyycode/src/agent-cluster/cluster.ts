export * as AgentCluster from "./cluster"

import { ConfigAgentCluster } from "@/config/agent-cluster"
import { MailSession } from "@/communication/mail-session"
import { Provider } from "@/provider/provider"
import { ModelID, ProviderID } from "@/provider/schema"
import type { Session } from "@/session/session"
import type { MessageV2 } from "@/session/message-v2"
import type { PromptInput } from "@/session/prompt"
import { SessionRunState } from "@/session/run-state"
import type { MessageID, SessionID } from "@/session/schema"
import { Bus } from "@/bus"
import { BackgroundJob } from "@/background/job"
import * as Database from "@/storage/db"
import { and, eq, inArray } from "@/storage/db"
import { Cause, Effect, Option } from "effect"
import path from "path"
import { ulid } from "ulid"
import { AgentClusterEventTable, AgentClusterTaskTable } from "./cluster.sql"
import { Event } from "./event"
import { runInstructions } from "./planner"
import { buildTaskBrief, modelForComplexity } from "./dispatcher"
import { stepGate } from "./runtime"
import type { Plan, PlannedTask, TaskID, TaskStatus } from "./schema"

type ModelRef = {
  providerID: ProviderID
  modelID: ModelID
  variant?: string
}

type ClusterModels = {
  planner: ModelRef
  simple: ModelRef
  complex: ModelRef
  visual: ModelRef
}

type TaskRow = typeof AgentClusterTaskTable.$inferSelect

export const ACTIVE_TASK_STATUSES = [
  "planned",
  "queued",
  "running",
  "submitted",
  "reviewing",
  "revision_requested",
  "revising",
] as const satisfies readonly TaskStatus[]

function isActiveTaskStatus(status: TaskStatus) {
  return (ACTIVE_TASK_STATUSES as readonly string[]).includes(status)
}

function sameStrings(left: readonly string[], right: readonly string[]) {
  return [...left].sort().join("\u0000") === [...right].sort().join("\u0000")
}

function normalizeTaskTitle(value: string) {
  return value.trim().toLowerCase().replace(/\s+/g, " ")
}

export function incrementalPlan(plan: Plan, history: readonly TaskRow[]): Plan {
  const accepted = history.filter((task) => task.status === "accepted")
  const completed = new Set(
    plan.tasks
      .filter((task) =>
        accepted.some(
          (row) =>
            row.id === task.id &&
            normalizeTaskTitle(row.title) === normalizeTaskTitle(task.title) &&
            sameStrings(row.artifact_paths, task.expectedArtifacts),
        ),
      )
      .map((task) => task.id),
  )
  const remaining = plan.tasks.filter((task) => !completed.has(task.id))
  return {
    ...plan,
    tasks: remaining.map((task) => ({
      ...task,
      dependencies: task.dependencies.filter((dependency) => !completed.has(dependency)),
    })),
  }
}

const publishTaskState = Effect.fn("AgentCluster.publishTaskState")(function* (input: {
  sessionID: SessionID
  taskID: TaskID
  message?: string
}) {
  const state = yield* Database.query((db) =>
    Effect.gen(function* () {
      const task = (yield* db
        .select()
        .from(AgentClusterTaskTable)
        .where(and(eq(AgentClusterTaskTable.session_id, input.sessionID), eq(AgentClusterTaskTable.id, input.taskID)))
        .get()) as TaskRow | undefined
      if (!task) return
      return { task }
    }),
  )
  if (!state) return

  const createdAt = Date.now()
  const message = input.message ?? `task ${input.taskID}: ${state.task.status}`
  const metadata = {
    status: state.task.status,
    childSessionID: state.task.child_session_id,
  }
  yield* Database.query((db) =>
    db
      .insert(AgentClusterEventTable)
      .values({
        id: ulid(),
        session_id: input.sessionID,
        origin_message_id: state.task.origin_message_id,
        task_id: input.taskID,
        type: "task",
        message,
        metadata,
      })
      .run(),
  )

  const bus = Option.getOrUndefined(yield* Effect.serviceOption(Bus.Service))
  if (!bus) return
  yield* bus.publish(Event, {
    sessionID: input.sessionID,
    taskID: input.taskID,
    type: "task",
    status: state.task.status,
    message,
    metadata,
    createdAt,
  })
})

export function isMailSession(session: Pick<Session.Info, "title" | "agent" | "path">) {
  if (MailSession.isMailSessionTitle(session.title)) return true
  if (session.agent === "mail") return true
  return session.path === "mail"
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

export const resolveModelRef = Effect.fn("AgentCluster.resolveModelRef")(function* (model: string, variant?: string) {
  const provider = yield* Provider.Service
  const normalizedVariant = variant?.trim() || undefined
  if (model.includes("/")) {
    const parsed = Provider.parseModel(model)
    const info = yield* provider.getModel(parsed.providerID, parsed.modelID)
    if (normalizedVariant && !info.variants?.[normalizedVariant]) {
      return yield* Effect.fail(new Error(`Agent cluster model variant not found: ${model}/${normalizedVariant}`))
    }
    return normalizedVariant ? { ...parsed, variant: normalizedVariant } : parsed
  }

  const providers = yield* provider.list()
  const matches = Object.values(providers)
    .filter((item) => item.models[model])
    .map((item) => ({ providerID: item.id, modelID: ModelID.make(model) }))
  if (matches.length === 1) {
    const parsed = matches[0]!
    const info = yield* provider.getModel(parsed.providerID, parsed.modelID)
    if (normalizedVariant && !info.variants?.[normalizedVariant]) {
      return yield* Effect.fail(new Error(`Agent cluster model variant not found: ${model}/${normalizedVariant}`))
    }
    return normalizedVariant ? { ...parsed, variant: normalizedVariant } : parsed
  }
  if (matches.length > 1) {
    return yield* Effect.fail(new Error(`Agent cluster model "${model}" is ambiguous; use provider/${model}`))
  }
  return yield* Effect.fail(new Error(`Agent cluster model not found: ${model}`))
})

export const resolveModels = Effect.fn("AgentCluster.resolveModels")(function* (config: ConfigAgentCluster.Info) {
  const resolved = ConfigAgentCluster.resolve(config)
  return yield* Effect.all(
    {
      planner: resolveModelRef(resolved.planner_model, resolved.planner_variant),
      simple: resolveModelRef(resolved.simple_model, resolved.simple_variant),
      complex: resolveModelRef(resolved.complex_model, resolved.complex_variant),
      visual: resolveModelRef(resolved.visual_model, resolved.visual_variant),
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
  sessionID: SessionID
  session: Pick<Session.Info, "directory">
  config: ConfigAgentCluster.Info
  models: ClusterModels
  reusableSubagents?: readonly {
    sessionID: SessionID
    lastTaskID: TaskID
    role: string
    title: string
    status: TaskStatus
  }[]
}): PromptInput {
  const config = ConfigAgentCluster.resolve(input.config)
  // When the user explicitly passes --model, use it as the planner model instead
  // of the configured default (e.g. deepseek-v4-flash).
  const plannerModel = input.prompt.model ?? input.models.planner
  return {
    ...input.prompt,
    agent: "cluster",
    ...(input.prompt.variant || input.prompt.model
      ? {}
      : input.models.planner.variant
        ? { variant: input.models.planner.variant }
        : {}),
    model: plannerModel,
    parts: [
      ...input.prompt.parts,
      {
        type: "text" as const,
        synthetic: true,
        text: runInstructions({
          sessionID: input.sessionID,
          artifactDir: artifactDir({ session: input.session, config }),
          simpleModel: formatModel(input.models.simple),
          complexModel: formatModel(input.models.complex),
          visualModel: formatModel(input.models.visual),
          maxSubagents: config.max_subagents,
          maxConcurrency: config.max_concurrency,
          maxReviewRounds: config.max_review_rounds,
          reusableSubagents: input.reusableSubagents,
        }),
        metadata: {
          kind: "agent_cluster",
          sessionID: input.sessionID,
        },
      },
    ],
  }
}

export const persistPlan = Effect.fn("AgentCluster.persistPlan")(function* (input: {
  sessionID: SessionID
  originMessageID?: MessageID
  plan: Plan
}) {
  const now = Date.now()
  const history = (yield* getSessionState(input.sessionID)).tasks
  const plan = incrementalPlan(input.plan, history)
  if (plan.tasks.length === 0) return
  const existingByID = new Map(history.map((task) => [task.id, task]))
  const duplicate = plan.tasks.find((task) => {
    const existing = existingByID.get(task.id)
    return (
      existing &&
      (normalizeTaskTitle(existing.title) !== normalizeTaskTitle(task.title) ||
        existing.prompt !== task.prompt ||
        !sameStrings(existing.artifact_paths, task.expectedArtifacts))
    )
  })
  if (duplicate) {
    return yield* Effect.fail(
      new Error(
        `Cluster task id ${duplicate.id} is already used by a distinct task in this session. Choose a new task id.`,
      ),
    )
  }
  const newTasks = plan.tasks.filter((task) => !existingByID.has(task.id))
  if (newTasks.length === 0) return
  const stepOffset = history.reduce((highest, task) => Math.max(highest, task.step), 0)
  const inserted = yield* Database.query((db) =>
    db
      .insert(AgentClusterTaskTable)
      .values(
        newTasks.map((task) => ({
          id: task.id,
          session_id: input.sessionID,
          ...(input.originMessageID ? { origin_message_id: input.originMessageID } : {}),
          role: task.role,
          title: task.title,
          prompt: task.prompt,
          complexity: task.complexity,
          model: task.model,
          status: "planned" as const,
          step: stepOffset + task.step,
          dependencies: [...task.dependencies],
          acceptance_criteria: [...task.acceptanceCriteria],
          artifact_paths: [...task.expectedArtifacts],
          review_issues: [],
          time_created: now,
          time_updated: now,
        })),
      )
      .onConflictDoNothing()
      .returning({ id: AgentClusterTaskTable.id })
      .all(),
  )
  yield* Effect.forEach(inserted, (task) =>
    publishTaskState({ sessionID: input.sessionID, taskID: task.id, message: `task ${task.id}: planned` }),
  )
})

export const markTaskRunning = Effect.fn("AgentCluster.markTaskRunning")(function* (input: {
  sessionID?: SessionID
  taskID?: string
  childSessionID: SessionID
  model?: string
}) {
  if (!input.sessionID || !input.taskID) return
  const sessionID = input.sessionID
  const now = Date.now()
  // Transition from "revision_requested" → "revising"
  yield* Database.query((db) =>
    db
      .update(AgentClusterTaskTable)
      .set({
        child_session_id: input.childSessionID,
        status: "revising" as const,
        ...(input.model ? { model: input.model } : {}),
        time_updated: now,
      })
      .where(
        and(
          eq(AgentClusterTaskTable.session_id, sessionID),
          eq(AgentClusterTaskTable.id, input.taskID as TaskID),
          eq(AgentClusterTaskTable.status, "revision_requested"),
        ),
      )
      .run(),
  )
  // Transition from "planned" / "queued" → "running"; never overwrite
  // terminal states (submitted, failed, accepted, etc.) that may have been
  // set by a faster background job path.
  yield* Database.query((db) =>
    db
      .update(AgentClusterTaskTable)
      .set({
        child_session_id: input.childSessionID,
        status: "running" as const,
        ...(input.model ? { model: input.model } : {}),
        time_updated: now,
      })
      .where(
        and(
          eq(AgentClusterTaskTable.session_id, sessionID),
          eq(AgentClusterTaskTable.id, input.taskID as TaskID),
          inArray(AgentClusterTaskTable.status, ["planned", "queued"]),
        ),
      )
      .run(),
  )
  yield* publishTaskState({ sessionID, taskID: input.taskID as TaskID })
})

export const submitTaskResult = Effect.fn("AgentCluster.submitTaskResult")(function* (input: {
  sessionID?: SessionID
  taskID?: string
  childSessionID: SessionID
  summary: string
}) {
  if (!input.sessionID || !input.taskID) return
  const sessionID = input.sessionID
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
          eq(AgentClusterTaskTable.session_id, sessionID),
          eq(AgentClusterTaskTable.id, input.taskID as TaskID),
          // A fast background child can complete before the caller gets a
          // chance to persist its optimistic "running" transition. Accept
          // that first completion directly instead of dropping its summary.
          inArray(AgentClusterTaskTable.status, ["planned", "queued", "running", "revising"]),
        ),
      )
      .run(),
  )
  yield* publishTaskState({ sessionID, taskID: input.taskID as TaskID })
})

export const failTaskResult = Effect.fn("AgentCluster.failTaskResult")(function* (input: {
  sessionID?: SessionID
  taskID?: string
  childSessionID: SessionID
  error: string
}) {
  if (!input.sessionID || !input.taskID) return
  const sessionID = input.sessionID
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
          eq(AgentClusterTaskTable.session_id, sessionID),
          eq(AgentClusterTaskTable.id, input.taskID as TaskID),
          inArray(AgentClusterTaskTable.status, ["planned", "queued", "running", "revising"]),
        ),
      )
      .run(),
  )
  yield* publishTaskState({ sessionID, taskID: input.taskID as TaskID })
})

export const cancelTaskResult = Effect.fn("AgentCluster.cancelTaskResult")(function* (input: {
  sessionID?: SessionID
  taskID?: string
  childSessionID: SessionID
  reason: string
}) {
  if (!input.sessionID || !input.taskID) return
  const sessionID = input.sessionID
  yield* Database.query((db) =>
    db
      .update(AgentClusterTaskTable)
      .set({
        child_session_id: input.childSessionID,
        status: "cancelled" as const,
        review_issues: [input.reason],
        last_event: "cancelled",
        time_updated: Date.now(),
      })
      .where(
        and(
          eq(AgentClusterTaskTable.session_id, sessionID),
          eq(AgentClusterTaskTable.id, input.taskID as TaskID),
          inArray(AgentClusterTaskTable.status, ["planned", "queued", "running", "revising"]),
        ),
      )
      .run(),
  )
  yield* publishTaskState({ sessionID, taskID: input.taskID as TaskID })
})

/**
 * Stops one active child assignment. It is deliberately idempotent so late
 * background callbacks cannot turn an interrupted task into cancelled or failed.
 */
export const interruptChildAssignment = Effect.fn("AgentCluster.interruptChildAssignment")(function* (input: {
  sessionID: SessionID
  taskID: TaskID
  reason: string
}) {
  const task = (yield* Database.query((db) =>
    db
      .select()
      .from(AgentClusterTaskTable)
      .where(and(eq(AgentClusterTaskTable.session_id, input.sessionID), eq(AgentClusterTaskTable.id, input.taskID)))
      .get(),
  )) as TaskRow | undefined
  if (!task || !isActiveTaskStatus(task.status)) return { task, interrupted: false }

  const updated = yield* Database.query((db) =>
    db
      .update(AgentClusterTaskTable)
      .set({
        status: "interrupted" as const,
        review_issues: [...task.review_issues, input.reason],
        last_event: "interrupted",
        time_updated: Date.now(),
      })
      .where(
        and(
          eq(AgentClusterTaskTable.session_id, input.sessionID),
          eq(AgentClusterTaskTable.id, input.taskID),
          inArray(AgentClusterTaskTable.status, [...ACTIVE_TASK_STATUSES]),
        ),
      )
      .returning()
      .get(),
  )
  if (!updated) return { task, interrupted: false }

  yield* publishTaskState({
    sessionID: input.sessionID,
    taskID: input.taskID,
    message: `task ${input.taskID}: interrupted`,
  })
  if (updated.child_session_id) {
    const jobs = Option.getOrUndefined(yield* Effect.serviceOption(BackgroundJob.Service))
    if (jobs) yield* jobs.cancel(updated.child_session_id)
    // A child prompt runs in the session runner's scope, rather than inside
    // its background job fiber. Cancel both so a replacement assignment or
    // user steering message does not join the stale runner.
    const runState = Option.getOrUndefined(yield* Effect.serviceOption(SessionRunState.Service))
    if (runState) yield* runState.cancel(updated.child_session_id)
  }
  return { task: updated as TaskRow, interrupted: true }
})

export const interruptActiveChildAssignment = Effect.fn("AgentCluster.interruptActiveChildAssignment")(
  function* (input: { sessionID: SessionID; childSessionID: SessionID; reason: string }) {
    const rows = (yield* Database.query((db) =>
      db.select().from(AgentClusterTaskTable).where(eq(AgentClusterTaskTable.session_id, input.sessionID)).all(),
    )) as TaskRow[]
    const active = rows.find(
      (task) => task.child_session_id === input.childSessionID && isActiveTaskStatus(task.status),
    )
    if (!active) return { interrupted: false }
    return yield* interruptChildAssignment({ sessionID: input.sessionID, taskID: active.id, reason: input.reason })
  },
)

export const sessionTaskStatus = Effect.fn("AgentCluster.sessionTaskStatus")(function* (sessionID: SessionID) {
  const tasks = (yield* Database.query((db) =>
    db.select().from(AgentClusterTaskTable).where(eq(AgentClusterTaskTable.session_id, sessionID)).all(),
  )) as TaskRow[]
  const status: "open" | "completed" | "failed" = tasks.some(
    (task) => task.status === "failed" || task.status === "cancelled" || task.status === "interrupted",
  )
    ? "failed"
    : tasks.length > 0 && tasks.every((task) => task.status === "accepted")
      ? "completed"
      : "open"

  return status
})

export const finalizeSessionIfTerminal = Effect.fn("AgentCluster.finalizeSessionIfTerminal")(function* (
  sessionID: SessionID,
) {
  return (yield* sessionTaskStatus(sessionID)) === "completed"
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
  sessionID?: SessionID
  requestedTaskID?: string
  resumeSessionID?: string
  prompt: string
  config: ConfigAgentCluster.Info
}) {
  if (!input.sessionID || !input.requestedTaskID) {
    return {
      prompt: input.prompt,
      taskID: undefined as TaskID | undefined,
      childSessionID: undefined as SessionID | undefined,
      model: undefined as string | undefined,
      variant: undefined as string | undefined,
    }
  }
  const sessionID = input.sessionID
  const rows = (yield* Database.query((db) =>
    db.select().from(AgentClusterTaskTable).where(eq(AgentClusterTaskTable.session_id, sessionID)).all(),
  )) as TaskRow[]
  const target = rows.find((row) => row.id === input.requestedTaskID || row.child_session_id === input.requestedTaskID)
  if (!target) {
    const knownIDs = rows.map((r) => `${r.id}(step=${r.step},status=${r.status})`).join(", ")
    return yield* Effect.fail(
      new Error(
        `Unknown cluster task for session ${input.sessionID}: ${input.requestedTaskID}. ` +
          `Known tasks in this run: [${knownIDs || "(none — plan may not have been persisted yet)"}]. ` +
          `Hint: make sure the plan JSON was output before dispatching tasks, and that task_id matches exactly.`,
      ),
    )
  }
  if (target.status === "failed" || target.status === "cancelled" || target.status === "accepted") {
    return yield* Effect.fail(new Error(`Cluster task ${target.id} cannot be dispatched from status ${target.status}`))
  }
  const resumedSessionID = input.resumeSessionID as SessionID | undefined
  if (resumedSessionID) {
    const sessionState = yield* getSessionState(sessionID)
    let latestTask: TaskRow | undefined
    for (const task of sessionState?.tasks ?? []) {
      if (task.child_session_id !== resumedSessionID) continue
      if (!latestTask || latestTask.time_updated <= task.time_updated) latestTask = task
    }
    const reusable = latestTask
    if (!reusable) {
      return yield* Effect.fail(
        new Error(`Cannot resume subagent ${resumedSessionID}: it does not belong to this session task graph.`),
      )
    }
  }
  const isRevision = target.child_session_id === input.requestedTaskID || target.status === "revision_requested"
  if (!isRevision) {
    const gate = stepGate(rows, target.step)
    if (!gate.allowed) {
      const earlier = rows.filter((row) => row.step < target.step)
      const undispatched = earlier.filter((row) => row.status === "planned" || row.status === "queued")
      const running = earlier.filter((row) => row.status === "running" || row.status === "revising")
      const awaitingReview = earlier.filter((row) => row.status === "submitted" || row.status === "reviewing")
      const revisions = earlier.filter((row) => row.status === "revision_requested")
      const instructions: string[] = []
      if (undispatched.length)
        instructions.push(
          `dispatch the smallest earlier step first (${undispatched.map((row) => row.id).join(", ")}); do not review planned tasks`,
        )
      if (running.length)
        instructions.push(`wait for running tasks with task_status (${running.map((row) => row.id).join(", ")})`)
      if (awaitingReview.length)
        instructions.push(
          `call agent_cluster_review for submitted tasks (${awaitingReview.map((row) => row.id).join(", ")})`,
        )
      if (revisions.length)
        instructions.push(`resume revision-requested tasks (${revisions.map((row) => row.id).join(", ")})`)
      if (gate.rejected.length)
        instructions.push(`rejected tasks must be replaced with new tasks or the run must be failed`)
      return yield* Effect.fail(
        new Error(
          [
            `Step gate blocked: step ${target.step} cannot start until all earlier steps are accepted.`,
            undispatched.length
              ? `Undispatched: ${undispatched.map((row) => `${row.id}(${row.status})`).join(", ")}.`
              : undefined,
            running.length ? `Running: ${running.map((row) => row.id).join(", ")}.` : undefined,
            awaitingReview.length ? `Awaiting review: ${awaitingReview.map((row) => row.id).join(", ")}.` : undefined,
            revisions.length ? `Revision requested: ${revisions.map((row) => row.id).join(", ")}.` : undefined,
            gate.rejected.length ? `Rejected: ${gate.rejected.join(", ")}.` : undefined,
            instructions.length ? `Next action: ${instructions.join("; ")}.` : undefined,
          ]
            .filter(Boolean)
            .join(" "),
        ),
      )
    }
  }

  const task = plannedTaskFromRow(target)
  const config = ConfigAgentCluster.resolve(input.config)
  const model =
    task.model === "-"
      ? modelForComplexity({
          complexity: task.complexity,
          role: task.role,
          simpleModel: config.simple_model,
          complexModel: config.complex_model,
          visualModel: config.visual_model,
        })
      : task.model
  const variant =
    task.model !== "-"
      ? undefined
      : task.role === "chart" || task.role === "office"
        ? config.visual_variant || undefined
        : task.complexity === "simple"
          ? config.simple_variant || undefined
          : config.complex_variant || undefined
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
    goal: "Multi-Agent session task graph",
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
        .where(and(eq(AgentClusterTaskTable.session_id, sessionID), eq(AgentClusterTaskTable.id, target.id)))
        .run(),
    )
  }
  return {
    prompt,
    taskID: target.id,
    childSessionID: resumedSessionID ?? target.child_session_id ?? undefined,
    model,
    variant,
  }
})

export const getSessionState = Effect.fn("AgentCluster.getSessionState")(function* (sessionID: SessionID) {
  return yield* Database.query((db) =>
    Effect.gen(function* () {
      const tasks = (yield* db
        .select()
        .from(AgentClusterTaskTable)
        .where(eq(AgentClusterTaskTable.session_id, sessionID))
        .all()) as TaskRow[]
      const orderedTasks = [...tasks].sort(
        (left, right) =>
          left.step - right.step || left.time_created - right.time_created || left.id.localeCompare(right.id),
      )
      return { tasks: orderedTasks }
    }),
  )
})

export const reusableSubagents = Effect.fn("AgentCluster.reusableSubagents")(function* (sessionID: SessionID) {
  const state = yield* getSessionState(sessionID)
  const latestBySession = new Map<SessionID, TaskRow>()
  for (const task of state.tasks) {
    if (!task.child_session_id) continue
    const previous = latestBySession.get(task.child_session_id)
    if (!previous || previous.time_updated <= task.time_updated) latestBySession.set(task.child_session_id, task)
  }
  return [...latestBySession.values()]
    .filter(
      (task) =>
        task.status === "accepted" ||
        task.status === "failed" ||
        task.status === "cancelled" ||
        task.status === "interrupted",
    )
    .sort((left, right) => right.time_updated - left.time_updated)
    .map((task) => ({
      sessionID: task.child_session_id!,
      lastTaskID: task.id,
      role: task.role,
      title: task.title,
      status: task.status,
    }))
})

export const run = Effect.fn("AgentCluster.run")(function* (input: {
  session: Session.Info
  message: MessageV2.WithParts
  config: ConfigAgentCluster.Info
  models: ClusterModels
  runLoop: Effect.Effect<MessageV2.WithParts>
}) {
  const bus = yield* Bus.Service
  const publish = (message: string, phase: "planning" | "completed" | "failed") =>
    Effect.gen(function* () {
      const createdAt = Date.now()
      yield* Database.query((db) =>
        db
          .insert(AgentClusterEventTable)
          .values({
            id: ulid(),
            session_id: input.session.id,
            origin_message_id: input.message.info.id,
            type: "task",
            message,
            metadata: { phase },
          })
          .run(),
      )
      yield* bus.publish(Event, {
        sessionID: input.session.id,
        type: "run",
        message,
        metadata: { phase },
        createdAt,
      })
    })

  yield* publish("main: planning", "planning")

  return yield* input.runLoop.pipe(
    Effect.tap(() =>
      sessionTaskStatus(input.session.id).pipe(
        Effect.andThen((status) =>
          status === "completed"
            ? publish("main: completed", "completed")
            : status === "failed"
              ? publish("main: failed", "failed")
              : Effect.void,
        ),
      ),
    ),
    Effect.catchCause((cause) =>
      publish(`main: failed: ${Cause.pretty(cause)}`, "failed").pipe(Effect.andThen(Effect.failCause(cause))),
    ),
  )
})
