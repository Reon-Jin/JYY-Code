export * as WorkflowExecutor from "./executor"

import { Cause, Effect, Exit } from "effect"
import { ulid } from "ulid"
import type { SessionID } from "@/session/schema"
import { BuiltinWorkflows, GeneralWorkflow, createFollowUpTask, createRunPlanForWorkflow } from "./builtin"
import { WorkflowCollaboration } from "./collaboration"
import { WorkflowLedger } from "./ledger"
import { WorkflowRuntime } from "./runtime"
import { NodeID } from "./schema"
import type { ExecutionMode, NodeStatus, RunPlan, RunPlanTask } from "./schema"

export type MultiAgentPlanInput = {
  goal: string
  cancelTaskIDs?: readonly string[]
  tasks: readonly {
    id: string
    step: number
    title: string
    role: string
    prompt: string
    complexity: "simple" | "complex"
    model: string
    dependencies: readonly string[]
    acceptanceCriteria: readonly string[]
    expectedArtifacts: readonly string[]
  }[]
}

function delivered(message: unknown) {
  if (!message || typeof message !== "object") return false
  const parts = (message as { parts?: unknown }).parts
  return (
    Array.isArray(parts) &&
    parts.some(
      (part) =>
        typeof part === "object" &&
        part !== null &&
        ((part as { type?: unknown }).type === "tool" ||
          ((part as { type?: unknown }).type === "text" && typeof (part as { text?: unknown }).text === "string" && (part as { text: string }).text.trim().length > 0)),
    )
  )
}

function textDeliverable(message: unknown) {
  if (!message || typeof message !== "object" || !Array.isArray((message as { parts?: unknown }).parts)) return undefined
  const text = (message as { parts: Array<{ type?: unknown; text?: unknown }> }).parts
    .filter((part) => part.type === "text" && typeof part.text === "string")
    .map((part) => part.text as string)
    .join("\n")
    .trim()
  return text || undefined
}

export const ensureRunPlan = Effect.fn("WorkflowExecutor.ensureRunPlan")(function* (input: {
  sessionID: SessionID
  goal: string
  mode: ExecutionMode
}) {
  for (const workflow of BuiltinWorkflows) {
    yield* WorkflowRuntime.registerWorkflow({ workflow, scope: "builtin", source: `builtin:${workflow.id}`, installed: true })
  }
  const existing = yield* WorkflowRuntime.getSessionRunPlan(input.sessionID).pipe(Effect.exit)
  if (Exit.isFailure(existing)) {
    const pin = yield* WorkflowRuntime.getSessionWorkflowPin(input.sessionID)
    const workflow = BuiltinWorkflows.find(
      (candidate) => Boolean(pin) && candidate.id === pin!.workflowID && candidate.version === pin!.workflowVersion,
    ) ?? GeneralWorkflow
    const plan = createRunPlanForWorkflow({ ...input, workflow })
    const created = yield* WorkflowRuntime.createRunPlan({ plan, author: "main_agent" }).pipe(Effect.exit)
    if (Exit.isSuccess(created)) return created.value
    return yield* WorkflowRuntime.getSessionRunPlan(input.sessionID)
  }
  if (existing.value.mode === input.mode) return existing.value
  return yield* WorkflowRuntime.patchRunPlan({
    runPlanID: existing.value.id,
    author: "user",
    patch: {
      baseVersion: existing.value.version,
      reason: "execution mode changed",
      operations: [{ type: "set_mode", mode: input.mode }],
    },
  })
})

const nextTask = Effect.fn("WorkflowExecutor.nextTask")(function* (plan: RunPlan, goal: string) {
  const pending = plan.tasks.find((task) => task.status === "planned" || task.status === "revision_requested")
  if (pending) return { plan, task: pending }
  const dependencies = plan.tasks.filter((task) => task.status === "accepted").map((task) => task.id)
  const patched = yield* WorkflowRuntime.patchRunPlan({
    runPlanID: plan.id,
    author: "main_agent",
    patch: {
      baseVersion: plan.version,
      reason: "new user request",
      operations: [{ type: "add_task", task: createFollowUpTask(goal, dependencies) }],
    },
  })
  const task = patched.tasks.find((item) => item.status === "planned")
  if (!task) return yield* Effect.die("Workflow executor failed to create a follow-up task")
  return { plan: patched, task }
})

export const runSingle = Effect.fn("WorkflowExecutor.runSingle")(function* <A, E, R>(input: {
  sessionID: SessionID
  goal: string
  run: Effect.Effect<A, E, R>
}) {
  const plan = yield* ensureRunPlan({ sessionID: input.sessionID, goal: input.goal, mode: "single" })
  yield* WorkflowLedger.addContext({
    sessionID: input.sessionID,
    runPlanID: plan.id,
    source: "user_constraint",
    priority: "critical",
    provenance: `run-plan:${plan.id}`,
    retention: "session",
    cachePolicy: "stable",
    scope: { kind: "user-request" },
    content: input.goal,
  })
  const selected = yield* nextTask(plan, input.goal)
  const task: RunPlanTask = selected.task
  if (task.status === "planned") {
    yield* WorkflowRuntime.transitionNode({ sessionID: input.sessionID, runPlanID: selected.plan.id, nodeID: task.id, from: "planned", to: "ready" })
    yield* WorkflowRuntime.transitionNode({ sessionID: input.sessionID, runPlanID: selected.plan.id, nodeID: task.id, from: "ready", to: "running" })
  } else {
    yield* WorkflowRuntime.transitionNode({ sessionID: input.sessionID, runPlanID: selected.plan.id, nodeID: task.id, from: "revision_requested", to: "revising" })
  }

  const result = yield* input.run.pipe(
    Effect.tapError((error) =>
      WorkflowRuntime.transitionNode({
        sessionID: input.sessionID,
        runPlanID: selected.plan.id,
        nodeID: task.id,
        from: task.status === "planned" ? "running" : "revising",
        to: "failed",
        detail: { error: Cause.pretty(Cause.fail(error)) },
      }).pipe(Effect.ignore),
    ),
  )
  const from = task.status === "planned" ? "running" : "revising"
  yield* WorkflowRuntime.transitionNode({ sessionID: input.sessionID, runPlanID: selected.plan.id, nodeID: task.id, from, to: "submitted" })
  yield* WorkflowRuntime.transitionNode({ sessionID: input.sessionID, runPlanID: selected.plan.id, nodeID: task.id, from: "submitted", to: "reviewing" })
  if (!delivered(result)) {
    yield* WorkflowRuntime.transitionNode({ sessionID: input.sessionID, runPlanID: selected.plan.id, nodeID: task.id, from: "reviewing", to: "revision_requested", detail: { reason: "No deliverable was produced" } })
    return result
  }
  yield* WorkflowRuntime.transitionNode({
    sessionID: input.sessionID,
    runPlanID: selected.plan.id,
    nodeID: task.id,
    from: "reviewing",
    to: "accepted",
    detail: { validation: true, evidence: ["assistant response contains a text or tool deliverable"] },
  })
  const content = textDeliverable(result)
  yield* WorkflowLedger.putArtifact({
    sessionID: input.sessionID,
    runPlanID: selected.plan.id,
    nodeID: task.id,
    name: `${task.id}-result.md`,
    mediaType: content ? "text/markdown" : "application/json",
    ...(content ? { content } : {}),
    summary: `Validated deliverable for ${task.title}`,
    metadata: { taskID: task.id, validation: "assistant response contains a text or tool deliverable" },
  })
  return result
})

/**
 * The multi-agent entry point deliberately owns the root run lifecycle. Child
 * dispatchers may run independently, but there is no separate root loop for
 * collaboration: every root request first gets a workflow plan and an
 * auditable runtime event before the planner can create assignments.
 */
export const runMulti = Effect.fn("WorkflowExecutor.runMulti")(function* <A, E, R>(input: {
  sessionID: SessionID
  goal: string
  run: Effect.Effect<A, E, R>
}) {
  const plan = yield* ensureRunPlan({ sessionID: input.sessionID, goal: input.goal, mode: "multi" })
  yield* WorkflowLedger.addContext({
    sessionID: input.sessionID,
    runPlanID: plan.id,
    source: "user_constraint",
    priority: "critical",
    provenance: `run-plan:${plan.id}`,
    retention: "session",
    cachePolicy: "stable",
    scope: { kind: "user-request" },
    content: input.goal,
  })
  yield* WorkflowRuntime.recordEvent({
    id: ulid(),
    sessionID: input.sessionID,
    runPlanID: plan.id,
    type: "TaskStarted",
    payload: { mode: "multi", goal: input.goal, executor: "workflow-runtime" },
    createdAt: Date.now(),
  })
  return yield* input.run.pipe(
    Effect.tap(() =>
      WorkflowRuntime.recordEvent({
        id: ulid(),
        sessionID: input.sessionID,
        runPlanID: plan.id,
        type: "DeliverableReady",
        payload: { mode: "multi", executor: "workflow-runtime" },
        createdAt: Date.now(),
      }),
    ),
  )
})

/**
 * Applies planner output directly to the durable Run Plan. New sessions never
 * need an AgentCluster row as an intermediary, and accepted nodes remain
 * immutable across planner revisions.
 */
export const applyMultiAgentPlan = Effect.fn("WorkflowExecutor.applyMultiAgentPlan")(function* (input: {
  sessionID: SessionID
  plan: MultiAgentPlanInput
}) {
  let current = yield* ensureRunPlan({ sessionID: input.sessionID, goal: input.plan.goal, mode: "multi" })
  const byID = new Map(current.tasks.map((task) => [task.id.toString(), task]))
  const operations: any[] = []
  const cancellations = new Set(input.plan.cancelTaskIDs ?? [])

  for (const task of current.tasks) {
    if (task.id === "execute" && task.status === "planned") operations.push({ type: "remove_task", taskID: task.id })
    if (cancellations.has(task.id.toString()) && task.status !== "accepted") {
      operations.push({ type: "remove_task", taskID: task.id })
    }
  }
  const unknownCancellation = [...cancellations].find((taskID) => !byID.has(taskID))
  if (unknownCancellation) return yield* Effect.fail(new Error(`Cannot cancel unknown workflow task: ${unknownCancellation}`))
  const acceptedCancellation = [...cancellations].find((taskID) => byID.get(taskID)?.status === "accepted")
  if (acceptedCancellation) return yield* Effect.fail(new Error(`Accepted workflow task cannot be cancelled: ${acceptedCancellation}`))
  for (const task of input.plan.tasks) {
    const id = NodeID.make(task.id)
    const normalized = {
      title: task.title,
      dependsOn: task.dependencies.map((dependency) => NodeID.make(dependency)),
      role: task.role,
      prompt: task.prompt,
      model: task.model,
      complexity: task.complexity,
      expectedArtifacts: [...task.expectedArtifacts],
      acceptance: task.acceptanceCriteria.map((title, index) => ({ id: `criterion-${index + 1}`, title, required: true })),
    }
    const existing = byID.get(task.id)
    if (!existing) {
      operations.push({ type: "add_task", task: { id, stageID: "implementation", stepID: NodeID.make(`step-${task.step}`), status: "planned", ...normalized } })
      continue
    }
    if (existing.status === "accepted") continue
    operations.push({ type: "update_task", taskID: id, ...normalized })
  }
  if (operations.length) {
    current = yield* WorkflowRuntime.patchRunPlan({
      runPlanID: current.id,
      author: "main_agent",
      patch: { baseVersion: current.version, reason: "apply multi-agent plan", operations },
    })
  }
  for (const task of input.plan.tasks) {
    const nodeID = NodeID.make(task.id)
    const runtimeTask = current.tasks.find((item) => item.id === nodeID)
    if (!runtimeTask) continue
    yield* WorkflowCollaboration.reconcileAssignment({
      sessionID: input.sessionID,
      runPlanID: current.id,
      nodeID,
      agentID: `role:${task.role}`,
      role: task.role,
      workspaceID: `workflow/${current.id}/${nodeID}`,
      status: assignmentStatus(runtimeTask.status),
    })
  }
  return current
})

function assignmentStatus(status: NodeStatus) {
  if (status === "running" || status === "revising" || status === "checkpointed") return "running" as const
  if (status === "accepted" || status === "submitted" || status === "reviewing") return "completed" as const
  if (status === "failed" || status === "failed_with_report") return "failed" as const
  if (status === "interrupted") return "interrupted" as const
  return "assigned" as const
}

const reconcileTaskAssignment = Effect.fn("WorkflowExecutor.reconcileTaskAssignment")(function* (input: {
  sessionID: SessionID
  plan: RunPlan
  task: RunPlanTask
  childSessionID?: SessionID
  checkpoint?: string
}) {
  const assignment = (yield* WorkflowCollaboration.listAssignments(input.sessionID)).find(
    (item) => item.runPlanID === input.plan.id && item.nodeID === input.task.id,
  )
  if (!assignment) return
  yield* WorkflowCollaboration.reconcileAssignment({
    ...assignment,
    ...(input.childSessionID ? { childSessionID: input.childSessionID } : {}),
    status: assignmentStatus(input.task.status),
    ...(input.checkpoint ? { checkpoint: input.checkpoint } : {}),
  })
})

/** Prepares a Runtime-owned multi-agent node and enforces its dependency gate. */
export const prepareMultiTask = Effect.fn("WorkflowExecutor.prepareMultiTask")(function* (input: {
  sessionID: SessionID
  taskID: string
  force?: boolean
}) {
  let plan = yield* WorkflowRuntime.getSessionRunPlan(input.sessionID)
  let task = plan.tasks.find((item) => item.id === NodeID.make(input.taskID))
  if (!task) {
    const assignments = yield* WorkflowCollaboration.listAssignments(input.sessionID)
    const assignment = assignments.find((item) => item.childSessionID === input.taskID)
    task = assignment ? plan.tasks.find((item) => item.id === assignment.nodeID) : undefined
  }
  if (!task) return yield* Effect.fail(new Error(`Workflow task not found: ${input.taskID}`))
  if (task.status === "accepted") return yield* Effect.fail(new Error(`Workflow task ${task.id} is already accepted`))
  if (task.status === "failed" || task.status === "interrupted") {
    if (!input.force) return yield* Effect.fail(new Error(`Workflow task ${task.id} is ${task.status}; use force=true to replan it`))
    if (task.status === "failed") {
      yield* WorkflowRuntime.transitionNode({ sessionID: input.sessionID, runPlanID: plan.id, nodeID: task.id, from: "failed", to: "replan_requested" })
      yield* WorkflowRuntime.transitionNode({ sessionID: input.sessionID, runPlanID: plan.id, nodeID: task.id, from: "replan_requested", to: "planned" })
    } else {
      yield* WorkflowRuntime.transitionNode({ sessionID: input.sessionID, runPlanID: plan.id, nodeID: task.id, from: "interrupted", to: "needs_validation" })
      yield* WorkflowRuntime.transitionNode({ sessionID: input.sessionID, runPlanID: plan.id, nodeID: task.id, from: "needs_validation", to: "reassigned" })
    }
    plan = yield* WorkflowRuntime.getRunPlan(plan.id)
    task = plan.tasks.find((item) => item.id === task!.id)!
  }
  if (task.status === "planned") {
    yield* WorkflowRuntime.transitionNode({ sessionID: input.sessionID, runPlanID: plan.id, nodeID: task.id, from: "planned", to: "ready" })
    plan = yield* WorkflowRuntime.getRunPlan(plan.id)
    task = plan.tasks.find((item) => item.id === task!.id)!
  }
  if (task.status !== "ready" && task.status !== "revision_requested" && task.status !== "reassigned") {
    return yield* Effect.fail(new Error(`Workflow task ${task.id} cannot be dispatched from ${task.status}`))
  }
  yield* reconcileTaskAssignment({ sessionID: input.sessionID, plan, task })
  const assignment = (yield* WorkflowCollaboration.listAssignments(input.sessionID)).find(
    (item) => item.runPlanID === plan.id && item.nodeID === task!.id,
  )
  return { plan, task, ...(assignment?.childSessionID ? { childSessionID: assignment.childSessionID } : {}) }
})

export const startMultiTask = Effect.fn("WorkflowExecutor.startMultiTask")(function* (input: {
  sessionID: SessionID
  runPlanID: RunPlan["id"]
  taskID: RunPlanTask["id"]
  childSessionID: SessionID
}) {
  const plan = yield* WorkflowRuntime.getRunPlan(input.runPlanID)
  const task = plan.tasks.find((item) => item.id === input.taskID)
  if (!task) return yield* Effect.fail(new Error(`Workflow task not found: ${input.taskID}`))
  if (task.status === "ready" || task.status === "reassigned") {
    yield* WorkflowRuntime.transitionNode({ sessionID: input.sessionID, runPlanID: plan.id, nodeID: task.id, from: task.status, to: "running" })
  } else if (task.status === "revision_requested") {
    yield* WorkflowRuntime.transitionNode({ sessionID: input.sessionID, runPlanID: plan.id, nodeID: task.id, from: "revision_requested", to: "revising" })
  }
  const updated = yield* WorkflowRuntime.getRunPlan(plan.id)
  const current = updated.tasks.find((item) => item.id === input.taskID)!
  yield* reconcileTaskAssignment({ sessionID: input.sessionID, plan: updated, task: current, childSessionID: input.childSessionID })
  return current
})

export const submitMultiTask = Effect.fn("WorkflowExecutor.submitMultiTask")(function* (input: {
  sessionID: SessionID
  runPlanID: RunPlan["id"]
  taskID: RunPlanTask["id"]
  childSessionID: SessionID
  summary: string
}) {
  const plan = yield* WorkflowRuntime.getRunPlan(input.runPlanID)
  const task = plan.tasks.find((item) => item.id === input.taskID)
  if (!task) return yield* Effect.fail(new Error(`Workflow task not found: ${input.taskID}`))
  if (task.status === "running" || task.status === "revising") {
    yield* WorkflowRuntime.transitionNode({ sessionID: input.sessionID, runPlanID: plan.id, nodeID: task.id, from: task.status, to: "submitted" })
  }
  const updated = yield* WorkflowRuntime.getRunPlan(plan.id)
  const current = updated.tasks.find((item) => item.id === input.taskID)!
  const artifact = yield* WorkflowLedger.putArtifact({ sessionID: input.sessionID, runPlanID: updated.id, nodeID: current.id, name: `${current.id}-subagent-result.md`, mediaType: "text/markdown", content: input.summary, summary: `Subagent submission for ${current.title}`, metadata: { childSessionID: input.childSessionID } })
  yield* reconcileTaskAssignment({ sessionID: input.sessionID, plan: updated, task: current, childSessionID: input.childSessionID, checkpoint: input.summary })
  const assignment = (yield* WorkflowCollaboration.listAssignments(input.sessionID)).find(
    (item) => item.runPlanID === updated.id && item.nodeID === current.id,
  )
  const card = yield* WorkflowCollaboration.createBlackboardCard({
    sessionID: input.sessionID,
    type: "evidence",
    title: current.title,
    authorAgentID: assignment?.agentID ?? input.childSessionID,
    summary: input.summary,
    relatedTasks: [current.id],
    replaces: [],
    impactScope: "medium",
    artifacts: [artifact.uri],
  })
  yield* WorkflowCollaboration.transitionBlackboard({ cardID: card.id, from: "draft", to: "published" })
  return current
})

export const endMultiTask = Effect.fn("WorkflowExecutor.endMultiTask")(function* (input: {
  sessionID: SessionID
  runPlanID: RunPlan["id"]
  taskID: RunPlanTask["id"]
  childSessionID: SessionID
  outcome: "failed" | "interrupted"
  detail: string
}) {
  const plan = yield* WorkflowRuntime.getRunPlan(input.runPlanID)
  const task = plan.tasks.find((item) => item.id === input.taskID)
  if (!task) return yield* Effect.fail(new Error(`Workflow task not found: ${input.taskID}`))
  if (task.status === "running" || task.status === "revising") {
    yield* WorkflowRuntime.transitionNode({ sessionID: input.sessionID, runPlanID: plan.id, nodeID: task.id, from: task.status, to: input.outcome, detail: { error: input.detail } })
  }
  const updated = yield* WorkflowRuntime.getRunPlan(plan.id)
  const current = updated.tasks.find((item) => item.id === input.taskID)!
  yield* reconcileTaskAssignment({ sessionID: input.sessionID, plan: updated, task: current, childSessionID: input.childSessionID, checkpoint: input.detail })
  return current
})

/** Runtime-native projection used by planners and the Desktop shell. */
export const getMultiSessionState = Effect.fn("WorkflowExecutor.getMultiSessionState")(function* (sessionID: SessionID) {
  const plan = yield* WorkflowRuntime.getSessionRunPlan(sessionID)
  const assignments = yield* WorkflowCollaboration.listAssignments(sessionID)
  const reviews = yield* WorkflowCollaboration.listReviewFindings(sessionID)
  return {
    tasks: plan.tasks.map((task) => {
      const assignment = assignments.find((item) => item.runPlanID === plan.id && item.nodeID === task.id)
      const issues = reviews.filter((item) => item.runPlanID === plan.id && item.nodeID === task.id && item.status === "open").map((item) => item.summary)
      const step = Number(task.stepID.toString().replace(/^step-/, ""))
      return {
        id: task.id.toString(),
        step: Number.isFinite(step) && step > 0 ? step : 1,
        status: task.status,
        title: task.title,
        role: task.role ?? assignment?.role ?? "general",
        prompt: task.prompt ?? task.title,
        complexity: task.complexity ?? "simple",
        model: task.model ?? "-",
        dependencies: task.dependsOn.map((dependency) => dependency.toString()),
        acceptance_criteria: task.acceptance.map((rule) => rule.title),
        artifact_paths: task.expectedArtifacts ?? [],
        review_issues: issues,
        ...(assignment?.childSessionID ? { child_session_id: assignment.childSessionID } : {}),
        ...(assignment?.checkpoint ? { result_summary: assignment.checkpoint } : {}),
        last_event: task.status,
        time_created: plan.createdAt,
        time_updated: plan.updatedAt,
      }
    }),
  }
})
