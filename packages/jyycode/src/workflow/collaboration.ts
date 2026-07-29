export * as WorkflowCollaboration from "./collaboration"

import { and, desc, eq } from "drizzle-orm"
import { Effect, Schema } from "effect"
import { ulid } from "ulid"
import * as Database from "@/storage/db"
import type { AgentAssignment, BlackboardCard, ReviewFinding } from "./schema"
import { AgentAssignment as AgentAssignmentSchema, BlackboardCard as BlackboardCardSchema, ReviewFinding as ReviewFindingSchema } from "./schema"
import { WorkflowAgentAssignmentTable, WorkflowBlackboardCardTable, WorkflowNodeRuntimeTable, WorkflowReviewFindingTable } from "./workflow.sql"
import { WorkflowLedger } from "./ledger"
import { WorkflowRuntime } from "./runtime"

function card(row: typeof WorkflowBlackboardCardTable.$inferSelect): BlackboardCard {
  return Schema.decodeUnknownSync(BlackboardCardSchema)({
    id: row.id,
    sessionID: row.session_id,
    type: row.type,
    title: row.title,
    status: row.status,
    version: row.version,
    authorAgentID: row.author_agent_id,
    ...(row.approved_by ? { approvedBy: row.approved_by } : {}),
    summary: row.summary,
    relatedTasks: row.related_tasks,
    replaces: row.replaces,
    impactScope: row.impact_scope,
    artifacts: row.artifacts,
    createdAt: row.time_created,
    updatedAt: row.time_updated,
  })
}

function finding(row: typeof WorkflowReviewFindingTable.$inferSelect): ReviewFinding {
  return Schema.decodeUnknownSync(ReviewFindingSchema)({
    id: row.id,
    sessionID: row.session_id,
    ...(row.run_plan_id ? { runPlanID: row.run_plan_id } : {}),
    ...(row.node_id ? { nodeID: row.node_id } : {}),
    authorAgentID: row.author_agent_id,
    severity: row.severity,
    status: row.status,
    summary: row.summary,
    evidence: row.evidence,
    suggestion: row.suggestion,
    createdAt: row.time_created,
    updatedAt: row.time_updated,
  })
}

function assignment(row: typeof WorkflowAgentAssignmentTable.$inferSelect): AgentAssignment {
  return Schema.decodeUnknownSync(AgentAssignmentSchema)({
    id: row.id, sessionID: row.session_id, runPlanID: row.run_plan_id, nodeID: row.node_id,
    agentID: row.agent_id, role: row.role, workspaceID: row.workspace_id,
    ...(row.child_session_id ? { childSessionID: row.child_session_id } : {}),
    status: row.status, ...(row.checkpoint ? { checkpoint: row.checkpoint } : {}),
    createdAt: row.time_created, updatedAt: row.time_updated,
  })
}

export const assignAgent = Effect.fn("WorkflowCollaboration.assignAgent")(function* (input: Omit<AgentAssignment, "id" | "status" | "createdAt" | "updatedAt"> & { id?: string }) {
  const now = Date.now()
  const value: AgentAssignment = { ...input, id: input.id ?? ulid(), status: "assigned", createdAt: now, updatedAt: now }
  yield* Database.withTransaction((db) => Effect.gen(function* () {
    yield* db.insert(WorkflowAgentAssignmentTable).values({
      id: value.id, session_id: value.sessionID, run_plan_id: value.runPlanID, node_id: value.nodeID,
      agent_id: value.agentID, role: value.role, workspace_id: value.workspaceID,
      ...(value.childSessionID ? { child_session_id: value.childSessionID } : {}), status: value.status,
      time_created: now, time_updated: now,
    }).run()
    yield* db.update(WorkflowNodeRuntimeTable).set({ assignee: value.agentID, time_updated: now }).where(and(eq(WorkflowNodeRuntimeTable.run_plan_id, value.runPlanID), eq(WorkflowNodeRuntimeTable.node_id, value.nodeID))).run()
  }))
  yield* WorkflowRuntime.recordEvent({ id: ulid(), sessionID: value.sessionID, runPlanID: value.runPlanID, nodeID: value.nodeID, type: "TaskAssigned", payload: { assignmentID: value.id, agentID: value.agentID, role: value.role, workspaceID: value.workspaceID }, createdAt: now })
  return value
})

export const listAssignments = Effect.fn("WorkflowCollaboration.listAssignments")(function* (sessionID: AgentAssignment["sessionID"]) {
  const rows = yield* Database.query((db) => db.select().from(WorkflowAgentAssignmentTable).where(eq(WorkflowAgentAssignmentTable.session_id, sessionID)).orderBy(desc(WorkflowAgentAssignmentTable.time_updated)).all())
  return rows.map(assignment)
})

export const updateAssignment = Effect.fn("WorkflowCollaboration.updateAssignment")(function* (input: { assignmentID: string; from: AgentAssignment["status"]; to: AgentAssignment["status"]; checkpoint?: string }) {
  const allowed: Record<AgentAssignment["status"], readonly AgentAssignment["status"][]> = { assigned: ["running", "interrupted"], running: ["checkpointed", "completed", "failed", "interrupted"], checkpointed: ["running", "interrupted"], completed: [], failed: [], interrupted: [] }
  if (!allowed[input.from].includes(input.to)) return yield* Effect.fail(new Error(`Invalid assignment transition: ${input.from} -> ${input.to}`))
  const row = yield* Database.query((db) => db.update(WorkflowAgentAssignmentTable).set({ status: input.to, ...(input.checkpoint ? { checkpoint: input.checkpoint } : {}), time_updated: Date.now() }).where(and(eq(WorkflowAgentAssignmentTable.id, input.assignmentID), eq(WorkflowAgentAssignmentTable.status, input.from))).returning().get())
  if (!row) return yield* Effect.fail(new Error(`Assignment transition conflict: ${input.assignmentID}`))
  return assignment(row)
})

/** Reconciles a durable assignment with an executor callback without creating a second assignment for the same node. */
export const reconcileAssignment = Effect.fn("WorkflowCollaboration.reconcileAssignment")(function* (input: {
  sessionID: AgentAssignment["sessionID"]
  runPlanID: AgentAssignment["runPlanID"]
  nodeID: AgentAssignment["nodeID"]
  agentID: string
  role: string
  workspaceID: string
  childSessionID?: AgentAssignment["childSessionID"]
  status: AgentAssignment["status"]
  checkpoint?: string
}) {
  const existing = yield* Database.query((db) =>
    db.select().from(WorkflowAgentAssignmentTable).where(and(eq(WorkflowAgentAssignmentTable.run_plan_id, input.runPlanID), eq(WorkflowAgentAssignmentTable.node_id, input.nodeID))).orderBy(desc(WorkflowAgentAssignmentTable.time_updated)).get(),
  )
  if (!existing) {
    const created = yield* assignAgent(input)
    if (input.status === "assigned") return created
    const path: Record<Exclude<AgentAssignment["status"], "assigned">, readonly AgentAssignment["status"][]> = {
      running: ["running"], checkpointed: ["running", "checkpointed"], completed: ["running", "completed"], failed: ["running", "failed"], interrupted: ["interrupted"],
    }
    let current = created
    for (const next of path[input.status]) current = yield* updateAssignment({ assignmentID: current.id, from: current.status, to: next, ...(input.checkpoint ? { checkpoint: input.checkpoint } : {}) })
    return current
  }
  const row = yield* Database.query((db) =>
    db.update(WorkflowAgentAssignmentTable).set({ agent_id: input.agentID, role: input.role, workspace_id: input.workspaceID, ...(input.childSessionID ? { child_session_id: input.childSessionID } : {}), status: input.status, ...(input.checkpoint ? { checkpoint: input.checkpoint } : {}), time_updated: Date.now() }).where(eq(WorkflowAgentAssignmentTable.id, existing.id)).returning().get(),
  )
  if (!row) return yield* Effect.die(`Workflow assignment disappeared during reconciliation: ${existing.id}`)
  return assignment(row)
})

export const createBlackboardCard = Effect.fn("WorkflowCollaboration.createBlackboardCard")(function* (
  input: Omit<BlackboardCard, "id" | "version" | "status" | "createdAt" | "updatedAt"> & { id?: string },
) {
  const now = Date.now()
  const value: BlackboardCard = { ...input, id: input.id ?? ulid(), version: 1, status: "draft", createdAt: now, updatedAt: now }
  yield* Database.query((db) =>
    db
      .insert(WorkflowBlackboardCardTable)
      .values({
        id: value.id,
        session_id: value.sessionID,
        type: value.type,
        title: value.title,
        status: value.status,
        version: value.version,
        author_agent_id: value.authorAgentID,
        summary: value.summary,
        related_tasks: [...value.relatedTasks],
        replaces: [...value.replaces],
        impact_scope: value.impactScope,
        artifacts: [...value.artifacts],
        time_created: now,
        time_updated: now,
      })
      .run(),
  )
  return value
})

export const listBlackboard = Effect.fn("WorkflowCollaboration.listBlackboard")(function* (sessionID: BlackboardCard["sessionID"]) {
  const rows = yield* Database.query((db) =>
    db.select().from(WorkflowBlackboardCardTable).where(eq(WorkflowBlackboardCardTable.session_id, sessionID)).orderBy(desc(WorkflowBlackboardCardTable.time_updated)).all(),
  )
  return rows.map(card)
})

export const transitionBlackboard = Effect.fn("WorkflowCollaboration.transitionBlackboard")(function* (input: {
  cardID: string
  from: BlackboardCard["status"]
  to: BlackboardCard["status"]
  approvedBy?: string
}) {
  const allowed: Record<BlackboardCard["status"], readonly BlackboardCard["status"][]> = {
    draft: ["published", "rejected"],
    published: ["accepted", "rejected"],
    accepted: ["superseded"],
    superseded: [],
    rejected: [],
  }
  if (!allowed[input.from].includes(input.to)) return yield* Effect.fail(new Error(`Invalid blackboard transition: ${input.from} -> ${input.to}`))
  const now = Date.now()
  const updated = yield* Database.query((db) =>
    db
      .update(WorkflowBlackboardCardTable)
      .set({ status: input.to, ...(input.approvedBy ? { approved_by: input.approvedBy } : {}), time_updated: now })
      .where(eq(WorkflowBlackboardCardTable.id, input.cardID))
      .returning()
      .get(),
  )
  if (!updated) return yield* Effect.fail(new Error(`Blackboard card not found: ${input.cardID}`))
  const value = card(updated)
  if (input.to === "accepted") {
    yield* WorkflowLedger.addContext({
      sessionID: value.sessionID,
      source: "blackboard",
      priority: value.type === "contract" || value.type === "constraint" ? "critical" : "high",
      provenance: `blackboard:${value.id}`,
      retention: "session",
      cachePolicy: "stable",
      scope: { blackboardCardID: value.id },
      content: `${value.title}\n${value.summary}`,
    })
    const plan = yield* WorkflowRuntime.getSessionRunPlan(value.sessionID).pipe(Effect.option)
    yield* WorkflowRuntime.recordEvent({
      id: ulid(),
      sessionID: value.sessionID,
      ...(plan._tag === "Some" ? { runPlanID: plan.value.id } : {}),
      type: "BlackboardAccepted",
      payload: { cardID: value.id, type: value.type },
      createdAt: now,
    })
  }
  return value
})

export const createReviewFinding = Effect.fn("WorkflowCollaboration.createReviewFinding")(function* (
  input: Omit<ReviewFinding, "id" | "status" | "createdAt" | "updatedAt"> & { id?: string },
) {
  const now = Date.now()
  const value: ReviewFinding = { ...input, id: input.id ?? ulid(), status: "open", createdAt: now, updatedAt: now }
  yield* Database.query((db) =>
    db
      .insert(WorkflowReviewFindingTable)
      .values({
        id: value.id,
        session_id: value.sessionID,
        ...(value.runPlanID ? { run_plan_id: value.runPlanID } : {}),
        ...(value.nodeID ? { node_id: value.nodeID } : {}),
        author_agent_id: value.authorAgentID,
        severity: value.severity,
        status: value.status,
        summary: value.summary,
        evidence: [...value.evidence],
        suggestion: value.suggestion,
        time_created: now,
        time_updated: now,
      })
      .run(),
  )
  return value
})

export const listReviewFindings = Effect.fn("WorkflowCollaboration.listReviewFindings")(function* (sessionID: ReviewFinding["sessionID"]) {
  const rows = yield* Database.query((db) =>
    db.select().from(WorkflowReviewFindingTable).where(eq(WorkflowReviewFindingTable.session_id, sessionID)).orderBy(desc(WorkflowReviewFindingTable.time_updated)).all(),
  )
  return rows.map(finding)
})

export const resolveReviewFinding = Effect.fn("WorkflowCollaboration.resolveReviewFinding")(function* (input: {
  findingID: string
  status: Extract<ReviewFinding["status"], "accepted" | "rejected" | "resolved">
}) {
  const updated = yield* Database.query((db) =>
    db
      .update(WorkflowReviewFindingTable)
      .set({ status: input.status, time_updated: Date.now() })
      .where(eq(WorkflowReviewFindingTable.id, input.findingID))
      .returning()
      .get(),
  )
  if (!updated) return yield* Effect.fail(new Error(`Review finding not found: ${input.findingID}`))
  return finding(updated)
})
