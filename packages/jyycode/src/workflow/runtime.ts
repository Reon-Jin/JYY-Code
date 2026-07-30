export * as WorkflowRuntime from "./runtime"

import { and, eq } from "drizzle-orm"
import { Effect, Schema } from "effect"
import { ulid } from "ulid"
import * as Database from "@/storage/db"
import type { SessionID } from "@/session/schema"
import { BuiltinWorkflows, createRunPlanForWorkflow } from "./builtin"
import { Event } from "./event"
import type { NodeID, NodeStatus, PlanPatch, RunPlan, RunPlanTask, Workflow } from "./schema"
import { RunPlan as RunPlanSchema, RunPlanVersion as RunPlanVersionSchema } from "./schema"
import { assertTransition } from "./state-machine"
import { validatePatch, validateRunPlan } from "./validation"
import {
  PlanPatchOperationTable,
  RunPlanTable,
  RunPlanVersionTable,
  SessionWorkflowPinTable,
  WorkflowNodeRuntimeTable,
  WorkflowRuntimeEventTable,
  WorkflowTemplateTable,
  WorkflowVersionTable,
} from "./workflow.sql"
import { validateWorkflow } from "./validation"

function snapshot(plan: RunPlan) {
  return plan as unknown as Record<string, unknown>
}

/**
 * Built-in workflows must stay selectable while an existing installation is
 * being upgraded.  Older local databases may not have received the workflow
 * catalogue rows yet; the definitions are still part of this executable.
 */
function builtinWorkflow(workflowID: Workflow["id"], workflowVersion: Workflow["version"]) {
  return BuiltinWorkflows.find((workflow) => workflow.id === workflowID && workflow.version === workflowVersion)
}

export function applyPlanPatch(plan: RunPlan, patch: PlanPatch) {
  validatePatch(plan, patch)
  const tasks = new Map(plan.tasks.map((task) => [task.id, task]))
  let mode = plan.mode
  for (const operation of patch.operations) {
    switch (operation.type) {
      case "add_task":
        tasks.set(operation.task.id, operation.task)
        break
      case "remove_task":
        tasks.delete(operation.taskID)
        break
      case "set_mode":
        mode = operation.mode
        break
      case "update_task": {
        const current = tasks.get(operation.taskID)!
        tasks.set(operation.taskID, {
          ...current,
          ...(operation.title === undefined ? {} : { title: operation.title }),
          ...(operation.dependsOn === undefined ? {} : { dependsOn: operation.dependsOn }),
          ...(operation.role === undefined ? {} : { role: operation.role }),
          ...(operation.prompt === undefined ? {} : { prompt: operation.prompt }),
          ...(operation.model === undefined ? {} : { model: operation.model }),
          ...(operation.complexity === undefined ? {} : { complexity: operation.complexity }),
          ...(operation.expectedArtifacts === undefined ? {} : { expectedArtifacts: operation.expectedArtifacts }),
          ...(operation.acceptance === undefined ? {} : { acceptance: operation.acceptance }),
        })
        break
      }
    }
  }
  const next: RunPlan = { ...plan, version: plan.version + 1, mode, tasks: [...tasks.values()], updatedAt: Date.now() }
  validateRunPlan(next)
  return next
}

export const recordEvent = Effect.fn("WorkflowRuntime.recordEvent")(function* (event: Event) {
  yield* Database.query((db) =>
    db
      .insert(WorkflowRuntimeEventTable)
      .values({
        id: event.id,
        session_id: event.sessionID,
        ...(event.runPlanID ? { run_plan_id: event.runPlanID } : {}),
        ...(event.nodeID ? { node_id: event.nodeID } : {}),
        type: event.type,
        payload: event.payload,
        time_created: event.createdAt,
      })
      .run(),
  )
})

export const listEvents = Effect.fn("WorkflowRuntime.listEvents")(function* (sessionID: SessionID, limit = 100) {
  const rows = yield* Database.query((db) =>
    db
      .select()
      .from(WorkflowRuntimeEventTable)
      .where(eq(WorkflowRuntimeEventTable.session_id, sessionID))
      .orderBy(WorkflowRuntimeEventTable.time_created)
      .all(),
  )
  return rows.slice(Math.max(0, rows.length - limit)).map((row) => ({
    id: row.id,
    sessionID: row.session_id,
    ...(row.run_plan_id ? { runPlanID: row.run_plan_id } : {}),
    ...(row.node_id ? { nodeID: row.node_id } : {}),
    type: row.type as Event["type"],
    payload: row.payload,
    createdAt: row.time_created,
  })) satisfies Event[]
})

export const createRunPlan = Effect.fn("WorkflowRuntime.createRunPlan")(function* (input: {
  plan: RunPlan
  author: "user" | "main_agent"
}) {
  validateRunPlan(input.plan)
  const workflow = yield* Database.query((db) =>
    db
      .select({ version: WorkflowVersionTable.version })
      .from(WorkflowVersionTable)
      .where(
        and(
          eq(WorkflowVersionTable.workflow_id, input.plan.workflowID),
          eq(WorkflowVersionTable.version, input.plan.workflowVersion),
        ),
      )
      .get(),
  )
  if (!workflow && !builtinWorkflow(input.plan.workflowID, input.plan.workflowVersion)) {
    return yield* Effect.fail(new Error(`Workflow version not found: ${input.plan.workflowID}@${input.plan.workflowVersion}`))
  }
  const now = Date.now()
  yield* Database.withTransaction((db) =>
    Effect.gen(function* () {
      yield* db
        .insert(SessionWorkflowPinTable)
        .values({
          session_id: input.plan.sessionID,
          workflow_id: input.plan.workflowID,
          workflow_version: input.plan.workflowVersion,
          time_created: now,
          time_updated: now,
        })
        .onConflictDoUpdate({
          target: SessionWorkflowPinTable.session_id,
          set: {
            workflow_id: input.plan.workflowID,
            workflow_version: input.plan.workflowVersion,
            time_updated: now,
          },
        })
        .run()
      yield* db
        .insert(RunPlanTable)
        .values({
          id: input.plan.id,
          session_id: input.plan.sessionID,
          workflow_id: input.plan.workflowID,
          workflow_version: input.plan.workflowVersion,
          version: input.plan.version,
          mode: input.plan.mode,
          goal: input.plan.goal,
          time_created: now,
          time_updated: now,
        })
        .run()
      yield* db
        .insert(RunPlanVersionTable)
        .values({
          run_plan_id: input.plan.id,
          version: input.plan.version,
          author: input.author,
          reason: "initial plan",
          snapshot: snapshot(input.plan),
          time_created: now,
          time_updated: now,
        })
        .run()
      yield* db
        .insert(WorkflowNodeRuntimeTable)
        .values(
          input.plan.tasks.map((task) => ({
            run_plan_id: input.plan.id,
            node_id: task.id,
            status: task.status,
            ...(task.assignee ? { assignee: task.assignee } : {}),
            time_created: now,
            time_updated: now,
          })),
        )
        .run()
    }),
  )
  yield* recordEvent({
    id: ulid(),
    sessionID: input.plan.sessionID,
    runPlanID: input.plan.id,
    type: "RunPlanCreated",
    payload: { version: input.plan.version, author: input.author },
    createdAt: now,
  })
  return input.plan
})

export const registerWorkflow = Effect.fn("WorkflowRuntime.registerWorkflow")(function* (input: {
  workflow: Workflow
  scope: "builtin" | "global" | "project"
  source: string
  installed?: boolean
}) {
  validateWorkflow(input.workflow)
  const now = Date.now()
  yield* Database.withTransaction((db) =>
    Effect.gen(function* () {
      yield* db
        .insert(WorkflowTemplateTable)
        .values({
          id: input.workflow.id,
          display_name: input.workflow.displayName,
          scope: input.scope,
          source: input.source,
          installed: input.installed ?? false,
          time_created: now,
          time_updated: now,
        })
        .onConflictDoUpdate({
          target: WorkflowTemplateTable.id,
          set: { display_name: input.workflow.displayName, scope: input.scope, source: input.source, time_updated: now },
        })
        .run()
      yield* db
        .insert(WorkflowVersionTable)
        .values({
          workflow_id: input.workflow.id,
          version: input.workflow.version,
          definition: input.workflow as unknown as Record<string, unknown>,
          time_created: now,
          time_updated: now,
        })
        .onConflictDoNothing()
        .run()
    }),
  )
})

export const pinWorkflow = Effect.fn("WorkflowRuntime.pinWorkflow")(function* (input: {
  sessionID: SessionID
  workflowID: Workflow["id"]
  workflowVersion: Workflow["version"]
}) {
  const existing = yield* Database.query((db) =>
    db
      .select({ version: WorkflowVersionTable.version })
      .from(WorkflowVersionTable)
      .where(and(eq(WorkflowVersionTable.workflow_id, input.workflowID), eq(WorkflowVersionTable.version, input.workflowVersion)))
      .get(),
  )
  if (!existing && !builtinWorkflow(input.workflowID, input.workflowVersion)) {
    return yield* Effect.fail(new Error(`Workflow version not found: ${input.workflowID}@${input.workflowVersion}`))
  }
  const now = Date.now()
  yield* Database.query((db) =>
    db
      .insert(SessionWorkflowPinTable)
      .values({ session_id: input.sessionID, workflow_id: input.workflowID, workflow_version: input.workflowVersion, time_created: now, time_updated: now })
      .onConflictDoUpdate({
        target: SessionWorkflowPinTable.session_id,
        set: { workflow_id: input.workflowID, workflow_version: input.workflowVersion, time_updated: now },
      })
      .run(),
  )
})

export const getSessionWorkflowPin = Effect.fn("WorkflowRuntime.getSessionWorkflowPin")(function* (sessionID: SessionID) {
  const pin = yield* Database.query((db) =>
    db
      .select({ workflowID: SessionWorkflowPinTable.workflow_id, workflowVersion: SessionWorkflowPinTable.workflow_version })
      .from(SessionWorkflowPinTable)
      .where(eq(SessionWorkflowPinTable.session_id, sessionID))
      .get(),
  )
  return pin
})

export const selectSessionWorkflow = Effect.fn("WorkflowRuntime.selectSessionWorkflow")(function* (input: {
  sessionID: SessionID
  workflowID: Workflow["id"]
  workflowVersion: Workflow["version"]
}) {
  const definition = yield* Database.query((db) =>
    db
      .select({ definition: WorkflowVersionTable.definition })
      .from(WorkflowVersionTable)
      .where(and(eq(WorkflowVersionTable.workflow_id, input.workflowID), eq(WorkflowVersionTable.version, input.workflowVersion)))
      .get(),
  )
  const fallback = builtinWorkflow(input.workflowID, input.workflowVersion)
  if (!definition && !fallback) return yield* Effect.fail(new Error(`Workflow version not found: ${input.workflowID}@${input.workflowVersion}`))

  const workflow = definition
    ? Schema.decodeUnknownSync(Schema.Struct({
        id: Schema.String,
        version: Schema.String,
        displayName: Schema.String,
        supports: Schema.Struct({ single: Schema.Boolean, multi: Schema.Boolean }),
        stages: Schema.Array(Schema.Unknown),
      }))(definition.definition) as Workflow
    : fallback!
  const currentExit = yield* getSessionRunPlan(input.sessionID).pipe(Effect.exit)

  if (currentExit._tag === "Failure") {
    yield* pinWorkflow(input)
    yield* recordEvent({
      id: ulid(),
      sessionID: input.sessionID,
      type: "WorkflowSelected",
      workflowID: input.workflowID,
      workflowVersion: input.workflowVersion,
      payload: { reason: "\u5728\u521b\u5efa\u65b9\u6848\u524d\u9009\u62e9\u5de5\u4f5c\u6d41" },
      createdAt: Date.now(),
    })
    return undefined
  }

  const current = currentExit.value
  if (current.workflowID === input.workflowID && current.workflowVersion === input.workflowVersion) return current
  if (current.tasks.some((task) => task.status !== "planned")) {
    return yield* Effect.fail(new Error("\u5f53\u524d\u65b9\u6848\u5df2\u7ecf\u5f00\u59cb\u6267\u884c\u3002\u4e3a\u4fdd\u62a4\u5df2\u6709\u7ed3\u679c\uff0c\u8bf7\u65b0\u5efa\u4f1a\u8bdd\u540e\u518d\u5207\u6362\u5de5\u4f5c\u6d41\u3002"))
  }

  const next = createRunPlanForWorkflow({
    sessionID: current.sessionID,
    goal: current.goal,
    mode: current.mode,
    workflow,
    id: current.id,
    version: current.version + 1,
  })
  validateRunPlan(next)
  const now = Date.now()
  yield* Database.withTransaction((db) =>
    Effect.gen(function* () {
      yield* db
        .insert(SessionWorkflowPinTable)
        .values({ session_id: input.sessionID, workflow_id: input.workflowID, workflow_version: input.workflowVersion, time_created: now, time_updated: now })
        .onConflictDoUpdate({
          target: SessionWorkflowPinTable.session_id,
          set: { workflow_id: input.workflowID, workflow_version: input.workflowVersion, time_updated: now },
        })
        .run()
      yield* db
        .update(RunPlanTable)
        .set({ workflow_id: next.workflowID, workflow_version: next.workflowVersion, version: next.version, time_updated: now })
        .where(and(eq(RunPlanTable.id, current.id), eq(RunPlanTable.version, current.version)))
        .run()
      yield* db
        .insert(RunPlanVersionTable)
        .values({
          run_plan_id: next.id,
          version: next.version,
          author: "user",
          reason: `\u5df2\u5207\u6362\u81f3${workflow.displayName}`,
          snapshot: snapshot(next),
          time_created: now,
          time_updated: now,
        })
        .run()
      yield* db.delete(WorkflowNodeRuntimeTable).where(eq(WorkflowNodeRuntimeTable.run_plan_id, next.id)).run()
      yield* db
        .insert(WorkflowNodeRuntimeTable)
        .values(next.tasks.map((task) => ({ run_plan_id: next.id, node_id: task.id, status: task.status, time_created: now, time_updated: now })))
        .run()
    }),
  )
  yield* recordEvent({
    id: ulid(),
    sessionID: input.sessionID,
    workflowID: input.workflowID,
    workflowVersion: input.workflowVersion,
    runPlanID: next.id,
    type: "WorkflowSelected",
    payload: { from: current.workflowID, to: input.workflowID, planVersion: next.version },
    createdAt: now,
  })
  return next
})

export const getRunPlan = Effect.fn("WorkflowRuntime.getRunPlan")(function* (runPlanID: RunPlan["id"]) {
  const row = yield* Database.query((db) =>
    db
      .select({ snapshot: RunPlanVersionTable.snapshot })
      .from(RunPlanTable)
      .innerJoin(RunPlanVersionTable, and(eq(RunPlanVersionTable.run_plan_id, RunPlanTable.id), eq(RunPlanVersionTable.version, RunPlanTable.version)))
      .where(eq(RunPlanTable.id, runPlanID))
      .get(),
  )
  if (!row) return yield* Effect.fail(new Error(`Run plan not found: ${runPlanID}`))
  const plan = Schema.decodeUnknownSync(RunPlanSchema)(row.snapshot)
  const nodes = yield* Database.query((db) =>
    db
      .select({ id: WorkflowNodeRuntimeTable.node_id, status: WorkflowNodeRuntimeTable.status, assignee: WorkflowNodeRuntimeTable.assignee })
      .from(WorkflowNodeRuntimeTable)
      .where(eq(WorkflowNodeRuntimeTable.run_plan_id, runPlanID))
      .all(),
  )
  const runtime = new Map(nodes.map((node) => [node.id, node]))
  return {
    ...plan,
    tasks: plan.tasks.map((task) => {
      const node = runtime.get(task.id)
      return node
        ? { ...task, status: node.status, ...(node.assignee ? { assignee: node.assignee } : {}) }
        : task
    }),
  }
})

export const getSessionRunPlan = Effect.fn("WorkflowRuntime.getSessionRunPlan")(function* (sessionID: SessionID) {
  const row = yield* Database.query((db) =>
    db.select({ id: RunPlanTable.id }).from(RunPlanTable).where(eq(RunPlanTable.session_id, sessionID)).get(),
  )
  if (!row) return yield* Effect.fail(new Error(`Run plan not found for session: ${sessionID}`))
  return yield* getRunPlan(row.id)
})

export const listRunPlanVersions = Effect.fn("WorkflowRuntime.listRunPlanVersions")(function* (runPlanID: RunPlan["id"]) {
  const plan = yield* Database.query((db) =>
    db.select({ id: RunPlanTable.id }).from(RunPlanTable).where(eq(RunPlanTable.id, runPlanID)).get(),
  )
  if (!plan) return yield* Effect.fail(new Error(`Run plan not found: ${runPlanID}`))
  const rows = yield* Database.query((db) =>
    db
      .select()
      .from(RunPlanVersionTable)
      .where(eq(RunPlanVersionTable.run_plan_id, runPlanID))
      .all(),
  )
  return rows
    .map((row) =>
      Schema.decodeUnknownSync(RunPlanVersionSchema)({
        version: row.version,
        author: row.author,
        reason: row.reason,
        snapshot: row.snapshot,
        createdAt: row.time_created,
      }),
    )
    .sort((left, right) => right.version - left.version)
})

export const restoreRunPlanVersion = Effect.fn("WorkflowRuntime.restoreRunPlanVersion")(function* (input: {
  runPlanID: RunPlan["id"]
  version: number
  baseVersion: number
  author: "user" | "main_agent"
}) {
  const current = yield* getRunPlan(input.runPlanID)
  if (current.version !== input.baseVersion) return yield* Effect.fail(new Error(`Plan version conflict: expected ${current.version}`))
  if (input.version === current.version) return yield* Effect.fail(new Error("The selected version is already current"))
  const versions = yield* listRunPlanVersions(input.runPlanID)
  const selected = versions.find((item) => item.version === input.version)
  if (!selected) return yield* Effect.fail(new Error(`Plan version not found: ${input.version}`))
  const target = selected.snapshot
  if (current.goal !== target.goal) return yield* Effect.fail(new Error("Cannot restore a version with a different session goal"))
  const currentTasks = new Map(current.tasks.map((task) => [task.id, task]))
  const targetTasks = new Map(target.tasks.map((task) => [task.id, task]))
  const unsafeRemoval = current.tasks.filter((task) => !targetTasks.has(task.id) && task.status !== "planned")
  if (unsafeRemoval.length) {
    return yield* Effect.fail(new Error(`Cannot restore this version because these tasks have started: ${unsafeRemoval.map((task) => task.id).join(", ")}`))
  }
  const operations: Array<PlanPatch["operations"][number]> = []
  if (current.mode !== target.mode) operations.push({ type: "set_mode", mode: target.mode })
  for (const task of current.tasks) {
    if (!targetTasks.has(task.id)) operations.push({ type: "remove_task", taskID: task.id })
  }
  for (const task of target.tasks) {
    const existing = currentTasks.get(task.id)
    if (!existing) {
      if (task.status !== "planned") return yield* Effect.fail(new Error(`Cannot restore task ${task.id} because its saved execution state is not planned`))
      operations.push({ type: "add_task", task })
      continue
    }
    if (existing.stageID !== task.stageID || existing.stepID !== task.stepID) {
      return yield* Effect.fail(new Error(`Cannot restore task ${task.id} because its workflow location changed`))
    }
    if (
      (existing.role !== undefined && task.role === undefined) ||
      (existing.prompt !== undefined && task.prompt === undefined) ||
      (existing.model !== undefined && task.model === undefined) ||
      (existing.complexity !== undefined && task.complexity === undefined) ||
      (existing.expectedArtifacts !== undefined && task.expectedArtifacts === undefined)
    ) {
      return yield* Effect.fail(new Error(`Cannot restore task ${task.id} because this version removes optional task metadata`))
    }
    const changed =
      existing.title !== task.title ||
      existing.dependsOn.join("\u0000") !== task.dependsOn.join("\u0000") ||
      existing.role !== task.role ||
      existing.prompt !== task.prompt ||
      existing.model !== task.model ||
      existing.complexity !== task.complexity ||
      JSON.stringify(existing.expectedArtifacts) !== JSON.stringify(task.expectedArtifacts) ||
      JSON.stringify(existing.acceptance) !== JSON.stringify(task.acceptance)
    if (changed) {
      operations.push({
        type: "update_task",
        taskID: task.id,
        title: task.title,
        dependsOn: task.dependsOn,
        ...(task.role === undefined ? {} : { role: task.role }),
        ...(task.prompt === undefined ? {} : { prompt: task.prompt }),
        ...(task.model === undefined ? {} : { model: task.model }),
        ...(task.complexity === undefined ? {} : { complexity: task.complexity }),
        ...(task.expectedArtifacts === undefined ? {} : { expectedArtifacts: task.expectedArtifacts }),
        acceptance: task.acceptance,
      })
    }
  }
  if (!operations.length) return yield* Effect.fail(new Error("The selected version has no restorable plan changes"))
  return yield* patchRunPlan({
    runPlanID: input.runPlanID,
    author: input.author,
    patch: {
      baseVersion: input.baseVersion,
      reason: `Restored plan version ${input.version}: ${selected.reason}`,
      operations,
    },
  })
})

export const patchRunPlan = Effect.fn("WorkflowRuntime.patchRunPlan")(function* (input: {
  runPlanID: RunPlan["id"]
  patch: PlanPatch
  author: "user" | "main_agent"
}) {
  const current = yield* getRunPlan(input.runPlanID)
  const next = applyPlanPatch(current, input.patch)
  const now = Date.now()
  yield* Database.withTransaction((db) =>
    Effect.gen(function* () {
      const updated = yield* db
        .update(RunPlanTable)
        .set({ version: next.version, mode: next.mode, goal: next.goal, time_updated: now })
        .where(and(eq(RunPlanTable.id, next.id), eq(RunPlanTable.version, current.version)))
        .returning({ id: RunPlanTable.id })
        .get()
      if (!updated) return yield* Effect.fail(new Error(`Plan version conflict: expected ${current.version}`))
      yield* db
        .insert(RunPlanVersionTable)
        .values({ run_plan_id: next.id, version: next.version, author: input.author, reason: input.patch.reason, snapshot: snapshot(next), time_created: now, time_updated: now })
        .run()
      yield* db
        .insert(PlanPatchOperationTable)
        .values(input.patch.operations.map((operation, ordinal) => ({ id: ulid(), run_plan_id: next.id, version: next.version, ordinal, operation, time_created: now, time_updated: now })))
        .run()
      for (const operation of input.patch.operations) {
        if (operation.type === "add_task") {
          yield* db.insert(WorkflowNodeRuntimeTable).values({ run_plan_id: next.id, node_id: operation.task.id, status: operation.task.status, ...(operation.task.assignee ? { assignee: operation.task.assignee } : {}), time_created: now, time_updated: now }).run()
        }
        if (operation.type === "remove_task") {
          yield* db.delete(WorkflowNodeRuntimeTable).where(and(eq(WorkflowNodeRuntimeTable.run_plan_id, next.id), eq(WorkflowNodeRuntimeTable.node_id, operation.taskID))).run()
        }
      }
    }),
  )
  yield* recordEvent({ id: ulid(), sessionID: next.sessionID, runPlanID: next.id, type: "RunPlanPatched", payload: { version: next.version, author: input.author, reason: input.patch.reason }, createdAt: now })
  return next
})

export const transitionNode = Effect.fn("WorkflowRuntime.transitionNode")(function* (input: {
  sessionID: SessionID
  runPlanID: RunPlan["id"]
  nodeID: NodeID
  from: NodeStatus
  to: NodeStatus
  detail?: Record<string, unknown>
}) {
  assertTransition(input.from, input.to)
  const plan = yield* getRunPlan(input.runPlanID)
  if (plan.sessionID !== input.sessionID) return yield* Effect.fail(new Error("Run plan does not belong to this session"))
  const task = plan.tasks.find((item) => item.id === input.nodeID)
  if (!task) return yield* Effect.fail(new Error(`Workflow node not found: ${input.nodeID}`))
  if (task.status !== input.from) return yield* Effect.fail(new Error(`Workflow node transition conflict: ${input.nodeID}`))
  if (input.to === "ready") {
    const incomplete = task.dependsOn.filter((dependencyID) => plan.tasks.find((item) => item.id === dependencyID)?.status !== "accepted")
    if (incomplete.length > 0) return yield* Effect.fail(new Error(`Workflow dependencies are not accepted: ${incomplete.join(", ")}`))
  }
  if (input.to === "accepted" && input.detail?.validation !== true) {
    return yield* Effect.fail(new Error("Accepted workflow nodes require validation evidence"))
  }
  const now = Date.now()
  const updated = yield* Database.query((db) =>
    db
      .update(WorkflowNodeRuntimeTable)
      .set({ status: input.to, ...(input.detail ? { detail: input.detail } : {}), time_updated: now })
      .where(
        and(
          eq(WorkflowNodeRuntimeTable.run_plan_id, input.runPlanID),
          eq(WorkflowNodeRuntimeTable.node_id, input.nodeID),
          eq(WorkflowNodeRuntimeTable.status, input.from),
        ),
      )
      .returning({ nodeID: WorkflowNodeRuntimeTable.node_id })
      .get(),
  )
  if (!updated) return yield* Effect.fail(new Error(`Workflow node transition conflict: ${input.nodeID}`))
  const eventType =
    input.to === "accepted"
      ? "TaskAccepted"
      : input.to === "submitted"
        ? "ArtifactSubmitted"
        : input.to === "reviewing"
          ? "ReviewRequested"
          : input.to === "revision_requested"
            ? "RevisionRequested"
            : input.to === "checkpointing"
              ? "CheckpointStarted"
              : "TaskStarted"
  yield* recordEvent({
    id: ulid(),
    sessionID: input.sessionID,
    runPlanID: input.runPlanID,
    nodeID: input.nodeID,
    type: eventType,
    payload: { from: input.from, to: input.to, ...(input.detail ? { detail: input.detail } : {}) },
    createdAt: now,
  })
})

export function taskFromPlan(task: RunPlanTask) {
  return { id: task.id, title: task.title, status: task.status, dependsOn: [...task.dependsOn] }
}
