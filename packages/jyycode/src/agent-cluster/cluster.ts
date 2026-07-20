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
import { Cause, Effect, Option } from "effect"
import path from "path"
import { ulid } from "ulid"
import { AgentClusterRunTable, AgentClusterEventTable, AgentClusterTaskTable } from "./cluster.sql"
import { Event } from "./event"
import { runInstructions } from "./planner"
import { buildTaskBrief, modelForComplexity } from "./dispatcher"
import { stepGate } from "./runtime"
import type { Plan, PlannedTask, RunID, RunStatus, TaskID, TaskStatus } from "./schema"

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
  const steps = [...new Set(remaining.map((task) => task.step))].sort((a, b) => a - b)
  const compactStep = new Map(steps.map((step, index) => [step, index + 1]))
  return {
    ...plan,
    tasks: remaining.map((task) => ({
      ...task,
      step: compactStep.get(task.step)!,
      dependencies: task.dependencies.filter((dependency) => !completed.has(dependency)),
    })),
  }
}

const publishTaskState = Effect.fn("AgentCluster.publishTaskState")(function* (input: {
  runID: RunID
  taskID: TaskID
  message?: string
}) {
  const state = yield* Database.query((db) =>
    Effect.gen(function* () {
      const task = (yield* db
        .select()
        .from(AgentClusterTaskTable)
        .where(and(eq(AgentClusterTaskTable.run_id, input.runID), eq(AgentClusterTaskTable.id, input.taskID)))
        .get()) as TaskRow | undefined
      if (!task) return
      const run = (yield* db
        .select({ sessionID: AgentClusterRunTable.session_id })
        .from(AgentClusterRunTable)
        .where(eq(AgentClusterRunTable.id, input.runID))
        .get()) as { sessionID: SessionID } | undefined
      if (!run) return
      return { task, run }
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
        run_id: input.runID,
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
    sessionID: state.run.sessionID,
    runID: input.runID,
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
  runID: string
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
          runID: input.runID,
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
          runID: input.runID,
        },
      },
    ],
  }
}

export const persistPlan = Effect.fn("AgentCluster.persistPlan")(function* (input: { runID: RunID; plan: Plan }) {
  const now = Date.now()
  const run = yield* Database.query((db) =>
    db
      .select({ sessionID: AgentClusterRunTable.session_id })
      .from(AgentClusterRunTable)
      .where(eq(AgentClusterRunTable.id, input.runID))
      .get(),
  )
  const history = run ? (yield* getSessionState(run.sessionID)).tasks.filter((task) => task.run_id !== input.runID) : []
  const plan = incrementalPlan(input.plan, history)
  if (plan.tasks.length === 0) return
  const inserted = yield* Database.query((db) =>
    db
      .insert(AgentClusterTaskTable)
      .values(
        plan.tasks.map((task) => ({
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
      .returning({ id: AgentClusterTaskTable.id })
      .all(),
  )
  yield* Effect.forEach(inserted, (task) =>
    publishTaskState({ runID: input.runID, taskID: task.id, message: `task ${task.id}: planned` }),
  )
})

export const markTaskRunning = Effect.fn("AgentCluster.markTaskRunning")(function* (input: {
  runID?: string
  taskID?: string
  childSessionID: SessionID
  model?: string
}) {
  if (!input.runID || !input.taskID) return
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
          eq(AgentClusterTaskTable.run_id, input.runID as RunID),
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
          eq(AgentClusterTaskTable.run_id, input.runID as RunID),
          eq(AgentClusterTaskTable.id, input.taskID as TaskID),
          inArray(AgentClusterTaskTable.status, ["planned", "queued"]),
        ),
      )
      .run(),
  )
  yield* publishTaskState({ runID: input.runID as RunID, taskID: input.taskID as TaskID })
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
  yield* publishTaskState({ runID: input.runID as RunID, taskID: input.taskID as TaskID })
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
  yield* publishTaskState({ runID: input.runID as RunID, taskID: input.taskID as TaskID })
  yield* finishRunFromTaskStates(input.runID as RunID)
})

export const cancelTaskResult = Effect.fn("AgentCluster.cancelTaskResult")(function* (input: {
  runID?: string
  taskID?: string
  childSessionID: SessionID
  reason: string
}) {
  if (!input.runID || !input.taskID) return
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
          eq(AgentClusterTaskTable.run_id, input.runID as RunID),
          eq(AgentClusterTaskTable.id, input.taskID as TaskID),
          inArray(AgentClusterTaskTable.status, ["planned", "queued", "running", "revising"]),
        ),
      )
      .run(),
  )
  yield* publishTaskState({ runID: input.runID as RunID, taskID: input.taskID as TaskID })
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
  resumeSessionID?: string
  prompt: string
  config: ConfigAgentCluster.Info
}) {
  if (!input.runID || !input.requestedTaskID) {
    return {
      prompt: input.prompt,
      taskID: undefined as TaskID | undefined,
      childSessionID: undefined as SessionID | undefined,
      model: undefined as string | undefined,
      variant: undefined as string | undefined,
    }
  }
  const runID = input.runID as RunID
  const rows = (yield* Database.query((db) =>
    db.select().from(AgentClusterTaskTable).where(eq(AgentClusterTaskTable.run_id, runID)).all(),
  )) as TaskRow[]
  const target = rows.find((row) => row.id === input.requestedTaskID || row.child_session_id === input.requestedTaskID)
  if (!target) {
    const knownIDs = rows.map((r) => `${r.id}(step=${r.step},status=${r.status})`).join(", ")
    return yield* Effect.fail(
      new Error(
        `Unknown cluster task for run ${runID}: ${input.requestedTaskID}. ` +
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
    const run = (yield* Database.query((db) =>
      db
        .select({ sessionID: AgentClusterRunTable.session_id })
        .from(AgentClusterRunTable)
        .where(eq(AgentClusterRunTable.id, runID))
        .get(),
    )) as { sessionID: SessionID } | undefined
    const sessionState = run ? yield* getSessionState(run.sessionID) : undefined
    let latestTask: TaskRow | undefined
    for (const task of sessionState?.tasks ?? []) {
      if (task.child_session_id !== resumedSessionID) continue
      if (!latestTask || latestTask.time_updated <= task.time_updated) latestTask = task
    }
    const reusable =
      latestTask &&
      (latestTask.status === "accepted" || latestTask.status === "failed" || latestTask.status === "cancelled")
    if (!reusable) {
      return yield* Effect.fail(
        new Error(
          `Cannot resume subagent ${resumedSessionID}: it is not a completed child task from this parent session.`,
        ),
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
      : task.role === "picture_searcher" || task.role === "chart" || task.role === "pdf"
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
    childSessionID: resumedSessionID ?? target.child_session_id ?? undefined,
    model,
    variant,
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
      const orderedRuns = [...runs].sort(
        (left, right) => left.time_created - right.time_created || left.id.localeCompare(right.id),
      )
      const runOrder = new Map(orderedRuns.map((run, index) => [run.id, index]))
      const orderedTasks = [...tasks].sort(
        (left, right) =>
          (runOrder.get(left.run_id) ?? Number.MAX_SAFE_INTEGER) -
            (runOrder.get(right.run_id) ?? Number.MAX_SAFE_INTEGER) ||
          left.step - right.step ||
          left.time_created - right.time_created ||
          left.id.localeCompare(right.id),
      )
      return { runs: orderedRuns, tasks: orderedTasks }
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
    .filter((task) => task.status === "accepted" || task.status === "failed" || task.status === "cancelled")
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
