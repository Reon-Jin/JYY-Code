import { describe, expect, test } from "bun:test"
import { Effect, Layer } from "effect"
import { AgentCluster } from "../../src/agent-cluster/cluster"
import { ClusterPrimaryPrompt } from "../../src/agent-cluster/planner"
import { AgentClusterRuntime } from "../../src/agent-cluster/runtime"
import { Session } from "../../src/session/session"
import * as Database from "../../src/storage/db"
import { WorkflowExecutor } from "../../src/workflow/executor"
import { WorkflowRuntime } from "../../src/workflow/runtime"
import { testEffect } from "../lib/effect"

const it = testEffect(Layer.mergeAll(Session.defaultLayer, Database.layer))

describe("Multi-agent planner instructions", () => {
  test("describe dependency steps as durable dispatch waves", () => {
    expect(ClusterPrimaryPrompt).toContain("agent_cluster_review")
    expect(ClusterPrimaryPrompt).toContain("strict gates")
  })

  test("includes session graph scheduling rules", () => {
    expect(ClusterPrimaryPrompt).toContain("task_id")
    expect(ClusterPrimaryPrompt).toContain("acceptance")
  })
})

describe("Multi-agent mode selection", () => {
  test("respects config and excludes child and mail sessions", () => {
    const config = { enabled: true, default_on: true }
    expect(AgentCluster.canUseAgentCluster({ session: { title: "Main", path: "", multiAgent: false }, config, requested: true })).toBe(true)
    expect(AgentCluster.canUseAgentCluster({ session: { title: "Main", path: "", parentID: "ses_parent" as any }, config, requested: true })).toBe(false)
    expect(AgentCluster.canUseAgentCluster({ session: { title: "Mail", agent: "mail", path: "", multiAgent: true }, config })).toBe(false)
  })
})

describe("Multi-agent plan parsing", () => {
  test("only makes the earliest unfinished wave ready", () => {
    const plan = AgentClusterRuntime.normalizePlan({
      goal: "Test", tasks: [
        { id: "first", step: 1, title: "First", role: "researcher", complexity: "simple", model: "test/model", dependencies: [], prompt: "First", acceptanceCriteria: [], expectedArtifacts: [] },
        { id: "second", step: 2, title: "Second", role: "coder", complexity: "simple", model: "test/model", dependencies: ["first"], prompt: "Second", acceptanceCriteria: [], expectedArtifacts: [] },
      ],
    })
    expect(plan).toBeDefined()
    expect(AgentClusterRuntime.nextReadyBatch(plan!, { completed: [] }).tasks.map((task) => task.id)).toEqual(["first"] as any)
    expect(AgentClusterRuntime.nextReadyBatch(plan!, { completed: ["first" as any] }).tasks.map((task) => task.id)).toEqual(["second"] as any)
  })

  test("rejects invalid graph topology", () => {
    const invalid = AgentClusterRuntime.normalizePlan({ goal: "Bad", tasks: [{ id: "a", step: 1, title: "A", role: "coder", complexity: "simple", model: "test/model", dependencies: ["missing"], prompt: "A", acceptanceCriteria: [], expectedArtifacts: [] }] })!
    const result = AgentClusterRuntime.validatePlan(invalid, { maxSubagents: 4, maxConcurrency: 2 })
    expect(result.valid).toBe(false)
  })

  test("extracts fenced plan JSON and cancellation updates", () => {
    const text = "```json\n{\"goal\":\"Test\",\"tasks\":[{\"id\":\"task\",\"step\":1,\"title\":\"Task\",\"role\":\"coder\",\"prompt\":\"Do it\"}]}\n```"
    expect(AgentClusterRuntime.extractPlanFromText(text)?.goal).toBe("Test")
    const cancellation = AgentClusterRuntime.extractPlanFromText("```json\n{\"goal\":\"Test\",\"tasks\":[],\"cancelTaskIDs\":[\"old\"]}\n```")
    expect((cancellation?.cancelTaskIDs ?? []).map(String)).toEqual(["old"])
  })
})

describe("Workflow Runtime multi-agent execution", () => {
  it.instance("enforces dependency gates and preserves accepted nodes across planner revisions", () =>
    Effect.gen(function* () {
      const sessions = yield* Session.Service
      const root = yield* sessions.create({ title: "Runtime graph" })
      const child = yield* sessions.create({ parentID: root.id, title: "First worker" })
      const initial = yield* WorkflowExecutor.applyMultiAgentPlan({
        sessionID: root.id,
        plan: { goal: "Ship", tasks: [
          { id: "first", step: 1, title: "First", role: "researcher", prompt: "Research", complexity: "simple", model: "test/model", dependencies: [], acceptanceCriteria: ["evidence"], expectedArtifacts: [] },
          { id: "second", step: 2, title: "Second", role: "coder", prompt: "Implement", complexity: "complex", model: "test/model", dependencies: ["first"], acceptanceCriteria: ["build"], expectedArtifacts: [] },
        ] },
      })
      const blocked = yield* WorkflowExecutor.prepareMultiTask({ sessionID: root.id, taskID: "second" }).pipe(Effect.exit)
      expect(blocked._tag).toBe("Failure")
      const first = yield* WorkflowExecutor.prepareMultiTask({ sessionID: root.id, taskID: "first" })
      yield* WorkflowExecutor.startMultiTask({ sessionID: root.id, runPlanID: first.plan.id, taskID: first.task.id, childSessionID: child.id })
      yield* WorkflowExecutor.submitMultiTask({ sessionID: root.id, runPlanID: first.plan.id, taskID: first.task.id, childSessionID: child.id, summary: "Evidence supplied." })
      yield* WorkflowRuntime.transitionNode({ sessionID: root.id, runPlanID: initial.id, nodeID: first.task.id, from: "submitted", to: "reviewing" })
      yield* WorkflowRuntime.transitionNode({ sessionID: root.id, runPlanID: initial.id, nodeID: first.task.id, from: "reviewing", to: "accepted", detail: { validation: true, evidence: ["evidence"] } })
      expect((yield* WorkflowExecutor.prepareMultiTask({ sessionID: root.id, taskID: "second" })).task.id).toBe("second" as any)
      const revised = yield* WorkflowExecutor.applyMultiAgentPlan({
        sessionID: root.id,
        plan: { goal: "Ship", tasks: [{ id: "first", step: 1, title: "Changed title", role: "researcher", prompt: "Changed", complexity: "simple", model: "test/model", dependencies: [], acceptanceCriteria: ["different"], expectedArtifacts: [] }, { id: "second", step: 2, title: "Second", role: "coder", prompt: "Implement", complexity: "complex", model: "test/model", dependencies: ["first"], acceptanceCriteria: ["build"], expectedArtifacts: [] }] },
      })
      expect(revised.tasks.find((task) => task.id === "first" as any)?.title).toBe("First")
    }),
  )

  it.instance("requires explicit cancellation for planned nodes", () =>
    Effect.gen(function* () {
      const root = yield* (yield* Session.Service).create({ title: "Cancellation" })
      const plan = yield* WorkflowExecutor.applyMultiAgentPlan({ sessionID: root.id, plan: { goal: "Cancel", tasks: [{ id: "keep", step: 1, title: "Keep", role: "coder", prompt: "Keep", complexity: "simple", model: "test/model", dependencies: [], acceptanceCriteria: [], expectedArtifacts: [] }, { id: "remove", step: 1, title: "Remove", role: "coder", prompt: "Remove", complexity: "simple", model: "test/model", dependencies: [], acceptanceCriteria: [], expectedArtifacts: [] }] } })
      const unchanged = yield* WorkflowExecutor.applyMultiAgentPlan({ sessionID: root.id, plan: { goal: "Cancel", tasks: [{ id: "keep", step: 1, title: "Keep", role: "coder", prompt: "Keep", complexity: "simple", model: "test/model", dependencies: [], acceptanceCriteria: [], expectedArtifacts: [] }] } })
      expect(unchanged.tasks.some((task) => task.id === "remove" as any)).toBe(true)
      const cancelled = yield* WorkflowExecutor.applyMultiAgentPlan({ sessionID: root.id, plan: { goal: "Cancel", cancelTaskIDs: ["remove"], tasks: [{ id: "keep", step: 1, title: "Keep", role: "coder", prompt: "Keep", complexity: "simple", model: "test/model", dependencies: [], acceptanceCriteria: [], expectedArtifacts: [] }] } })
      expect(cancelled.tasks.some((task) => task.id === "remove" as any)).toBe(false)
      expect(plan.id).toBe(cancelled.id)
    }),
  )
})
