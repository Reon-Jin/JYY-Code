import { describe, expect } from "bun:test"
import { Effect, Layer } from "effect"
import { Session } from "../../src/session/session"
import * as Database from "../../src/storage/db"
import { WorkflowExecutor } from "../../src/workflow/executor"
import { WorkflowCollaboration } from "../../src/workflow/collaboration"
import { WorkflowLedger } from "../../src/workflow/ledger"
import { WorkflowRuntime } from "../../src/workflow/runtime"
import { testEffect } from "../lib/effect"

const it = testEffect(Layer.mergeAll(Session.defaultLayer, Database.layer))

const workflow = {
  id: "general" as any,
  version: "2.0.0" as any,
  displayName: "General engineering",
  supports: { single: true, multi: true },
  stages: [
    {
      id: "implementation" as any,
      title: "Implementation",
      dependsOn: [],
      steps: [
        {
          id: "build" as any,
          title: "Build",
          dependsOn: [],
          tasks: [{ id: "code" as any, title: "Code", dependsOn: [], acceptance: [] }],
        },
      ],
    },
  ],
}

describe("Workflow Runtime persistence", () => {
  it.instance("runs a default single-agent task through review and validation", () =>
    Effect.gen(function* () {
      const session = yield* (yield* Session.Service).create({ title: "Execute workflow" })
      yield* WorkflowExecutor.runSingle({
        sessionID: session.id,
        goal: "Implement a small change",
        run: Effect.succeed({ parts: [{ type: "text", text: "Implemented and tested." }] }),
      })
      const first = yield* WorkflowRuntime.getSessionRunPlan(session.id)
      expect(first.mode).toBe("single")
      expect(first.tasks).toHaveLength(1)
      expect(first.tasks[0]?.status).toBe("accepted")
      expect((yield* WorkflowLedger.listArtifacts(session.id)).map((artifact) => artifact.content)).toContain(
        "Implemented and tested.",
      )
      expect((yield* WorkflowRuntime.listEvents(session.id)).map((event) => event.type)).toContain("TaskAccepted")

      yield* WorkflowExecutor.runSingle({
        sessionID: session.id,
        goal: "Add a follow-up",
        run: Effect.succeed({ parts: [{ type: "tool", tool: "write" }] }),
      })
      const second = yield* WorkflowRuntime.getSessionRunPlan(session.id)
      expect(second.tasks).toHaveLength(2)
      expect(second.tasks[1]?.dependsOn).toEqual([first.tasks[0]!.id])
      expect(second.tasks[1]?.status).toBe("accepted")

      const multi = yield* WorkflowExecutor.ensureRunPlan({ sessionID: session.id, goal: "Collaborate", mode: "multi" })
      expect(multi.mode).toBe("multi")
      expect(multi.version).toBeGreaterThan(second.version)
    }),
  )

  it.instance("routes multi-agent root turns through the workflow executor", () =>
    Effect.gen(function* () {
      const session = yield* (yield* Session.Service).create({ title: "Collaborative workflow" })
      const result = yield* WorkflowExecutor.runMulti({
        sessionID: session.id,
        goal: "Split a safe implementation review",
        run: Effect.succeed({ parts: [{ type: "text", text: "Planner started assignments." }] }),
      })
      expect(result.parts[0]?.type).toBe("text")
      expect((yield* WorkflowRuntime.getSessionRunPlan(session.id)).mode).toBe("multi")
      expect((yield* WorkflowLedger.searchContext({ sessionID: session.id, query: "Split", limit: 5 })).some((block) => block.content.includes("Split a safe implementation review"))).toBe(true)
    }),
  )

  it.instance("drives a dispatched child task through Runtime state and durable artifacts", () =>
    Effect.gen(function* () {
      const service = yield* Session.Service
      const session = yield* service.create({ title: "Runtime dispatch" })
      const child = yield* service.create({ parentID: session.id, title: "Worker" })
      const plan = yield* WorkflowExecutor.ensureRunPlan({ sessionID: session.id, goal: "Delegate a focused check", mode: "multi" })
      const task = plan.tasks[0]!
      yield* WorkflowCollaboration.assignAgent({
        sessionID: session.id,
        runPlanID: plan.id,
        nodeID: task.id,
        agentID: "agent:tester",
        role: "tester",
        workspaceID: "workflow/tester",
      })
      const prepared = yield* WorkflowExecutor.prepareMultiTask({ sessionID: session.id, taskID: task.id })
      expect(prepared.task.status).toBe("ready")
      yield* WorkflowExecutor.startMultiTask({ sessionID: session.id, runPlanID: plan.id, taskID: task.id, childSessionID: child.id })
      yield* WorkflowExecutor.submitMultiTask({ sessionID: session.id, runPlanID: plan.id, taskID: task.id, childSessionID: child.id, summary: "Validated the requested behavior." })
      expect((yield* WorkflowRuntime.getRunPlan(plan.id)).tasks.find((item) => item.id === task.id)?.status).toBe("submitted")
      expect((yield* WorkflowCollaboration.listAssignments(session.id))[0]?.status).toBe("completed")
      expect((yield* WorkflowLedger.listArtifacts(session.id)).some((artifact) => artifact.name === `${task.id}-subagent-result.md`)).toBe(true)
      expect((yield* WorkflowExecutor.getMultiSessionState(session.id)).tasks[0]).toMatchObject({ id: task.id, status: "submitted", child_session_id: child.id })
    }),
  )

  it.instance("pins an immutable workflow, persists patches, and enforces node transitions", () =>
    Effect.gen(function* () {
      const session = yield* (yield* Session.Service).create({ title: "Workflow runtime" })
      yield* WorkflowRuntime.registerWorkflow({ workflow, scope: "builtin", source: "test", installed: true })
      const plan = {
        id: "plan-runtime" as any,
        sessionID: session.id,
        workflowID: workflow.id,
        workflowVersion: workflow.version,
        version: 1,
        mode: "single" as const,
        goal: "Build a feature",
        tasks: [
          {
            id: "code" as any,
            title: "Code",
            stageID: "implementation" as any,
            stepID: "build" as any,
            dependsOn: [],
            status: "planned" as const,
            acceptance: [],
          },
        ],
        createdAt: Date.now(),
        updatedAt: Date.now(),
      }
      yield* WorkflowRuntime.createRunPlan({ plan, author: "main_agent" })
      const created = yield* WorkflowRuntime.getSessionRunPlan(session.id)
      expect(String(created.workflowVersion)).toBe("2.0.0")

      const patched = yield* WorkflowRuntime.patchRunPlan({
        runPlanID: created.id,
        author: "user",
        patch: { baseVersion: 1, reason: "enable collaboration", operations: [{ type: "set_mode", mode: "multi" }] },
      })
      expect(patched.version).toBe(2)
      expect(patched.mode).toBe("multi")
      const versions = yield* WorkflowRuntime.listRunPlanVersions(patched.id)
      expect(versions.map((item) => item.version)).toEqual([2, 1])
      const restored = yield* WorkflowRuntime.restoreRunPlanVersion({
        runPlanID: patched.id,
        version: 1,
        baseVersion: patched.version,
        author: "user",
      })
      expect(restored.mode).toBe("single")
      expect(restored.version).toBe(3)

      yield* WorkflowRuntime.transitionNode({
        sessionID: session.id,
        runPlanID: restored.id,
        nodeID: "code" as any,
        from: "planned",
        to: "ready",
      })
      yield* WorkflowRuntime.transitionNode({
        sessionID: session.id,
        runPlanID: patched.id,
        nodeID: "code" as any,
        from: "ready",
        to: "running",
      })
      yield* WorkflowRuntime.transitionNode({
        sessionID: session.id,
        runPlanID: patched.id,
        nodeID: "code" as any,
        from: "running",
        to: "submitted",
      })
      yield* WorkflowRuntime.transitionNode({
        sessionID: session.id,
        runPlanID: patched.id,
        nodeID: "code" as any,
        from: "submitted",
        to: "reviewing",
      })
      const missingEvidence = yield* WorkflowRuntime.transitionNode({
        sessionID: session.id,
        runPlanID: patched.id,
        nodeID: "code" as any,
        from: "reviewing",
        to: "accepted",
      }).pipe(Effect.exit)
      expect(missingEvidence._tag).toBe("Failure")
      yield* WorkflowRuntime.transitionNode({
        sessionID: session.id,
        runPlanID: patched.id,
        nodeID: "code" as any,
        from: "reviewing",
        to: "accepted",
        detail: { validation: true, evidence: ["unit test"] },
      })
      const completed = yield* WorkflowRuntime.getRunPlan(patched.id)
      expect(completed.tasks[0]?.status).toBe("accepted")
    }),
  )
})
