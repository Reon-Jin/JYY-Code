import { describe, expect } from "bun:test"
import { Effect, Layer } from "effect"
import { Session } from "../../src/session/session"
import * as Database from "../../src/storage/db"
import { WorkflowCollaboration } from "../../src/workflow/collaboration"
import { WorkflowExecutor } from "../../src/workflow/executor"
import { WorkflowRuntime } from "../../src/workflow/runtime"
import { WorkflowLedger } from "../../src/workflow/ledger"
import { testEffect } from "../lib/effect"

const it = testEffect(Layer.mergeAll(Session.defaultLayer, Database.layer))

describe("Workflow collaboration records", () => {
  it.instance("keeps multi-agent assignments durable and tied to run-plan nodes", () =>
    Effect.gen(function* () {
      const session = yield* (yield* Session.Service).create({ title: "Assignments" })
      const plan = yield* WorkflowExecutor.ensureRunPlan({ sessionID: session.id, goal: "Parallelize", mode: "multi" })
      const task = plan.tasks[0]!
      const assigned = yield* WorkflowCollaboration.assignAgent({
        sessionID: session.id, runPlanID: plan.id, nodeID: task.id, agentID: "agent-backend", role: "backend", workspaceID: "isolated/backend",
      })
      expect((yield* WorkflowCollaboration.updateAssignment({ assignmentID: assigned.id, from: "assigned", to: "running" })).status).toBe("running")
      expect((yield* WorkflowCollaboration.listAssignments(session.id))[0]?.agentID).toBe("agent-backend")
    }),
  )

  it.instance("applies a collaboration task graph directly to the authoritative run plan", () =>
    Effect.gen(function* () {
      const session = yield* (yield* Session.Service).create({ title: "Ingest" })
      yield* WorkflowExecutor.applyMultiAgentPlan({
        sessionID: session.id,
        plan: {
          goal: "Parallelize",
          tasks: [{ id: "research" as any, step: 1, title: "Research", role: "researcher", complexity: "simple", model: "test/model", dependencies: [], prompt: "Research", acceptanceCriteria: ["cite sources"], expectedArtifacts: ["notes.md"] }],
        },
      })
      const plan = yield* WorkflowRuntime.getSessionRunPlan(session.id)
      expect(plan.tasks.find((task) => task.id === "research" as any)?.title).toBe("Research")
      expect(plan.tasks.find((task) => task.id === "research" as any)?.prompt).toBe("Research")
      expect(plan.tasks.find((task) => task.id === "research" as any)?.expectedArtifacts).toEqual(["notes.md"])
      expect((yield* WorkflowCollaboration.listAssignments(session.id))[0]?.role).toBe("researcher")
      const child = yield* (yield* Session.Service).create({ parentID: session.id, title: "Research child" })
      const prepared = yield* WorkflowExecutor.prepareMultiTask({ sessionID: session.id, taskID: "research" })
      yield* WorkflowExecutor.startMultiTask({ sessionID: session.id, runPlanID: prepared.plan.id, taskID: prepared.task.id, childSessionID: child.id })
      yield* WorkflowExecutor.submitMultiTask({ sessionID: session.id, runPlanID: prepared.plan.id, taskID: prepared.task.id, childSessionID: child.id, summary: "Cited the relevant sources." })
      expect((yield* WorkflowRuntime.getSessionRunPlan(session.id)).tasks.find((task) => task.id === "research" as any)?.status).toBe("submitted")
      expect((yield* WorkflowCollaboration.listAssignments(session.id))[0]?.status).toBe("completed")
    }),
  )

  it.instance("publishes accepted blackboard constraints and tracks review findings", () =>
    Effect.gen(function* () {
      const session = yield* (yield* Session.Service).create({ title: "Collaboration" })
      const draft = yield* WorkflowCollaboration.createBlackboardCard({
        sessionID: session.id,
        type: "contract",
        title: "UI contract",
        authorAgentID: "main-agent",
        summary: "Use restrained neutral colors.",
        relatedTasks: [],
        replaces: [],
        impactScope: "high",
        artifacts: [],
      })
      const published = yield* WorkflowCollaboration.transitionBlackboard({ cardID: draft.id, from: "draft", to: "published" })
      const accepted = yield* WorkflowCollaboration.transitionBlackboard({ cardID: published.id, from: "published", to: "accepted", approvedBy: "main-agent" })
      expect(accepted.status).toBe("accepted")
      expect((yield* WorkflowLedger.searchContext({ sessionID: session.id, source: "blackboard" }))[0]?.content).toContain("restrained")

      const review = yield* WorkflowCollaboration.createReviewFinding({
        sessionID: session.id,
        authorAgentID: "reviewer",
        severity: "medium",
        summary: "Check contrast.",
        evidence: [],
        suggestion: "Increase contrast.",
      })
      expect((yield* WorkflowCollaboration.resolveReviewFinding({ findingID: review.id, status: "resolved" })).status).toBe("resolved")
    }),
  )
})
