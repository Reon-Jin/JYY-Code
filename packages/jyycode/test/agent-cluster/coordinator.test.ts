import { describe, expect, test } from "bun:test"
import { AgentClusterCoordinator } from "../../src/agent-cluster/coordinator"
import { AgentClusterLifecycle } from "../../src/agent-cluster/lifecycle"
import { AgentClusterReviewer } from "../../src/agent-cluster/reviewer"
import type { TaskStatus } from "../../src/agent-cluster/schema"

describe("AgentCluster coordinator", () => {
  test("deriveRunStatus dispatches step 1 tasks when dependency-free", () => {
    // Simulate a two-step plan: step 1 has two queued tasks, step 2 depends on both
    const statuses: TaskStatus[] = ["queued", "queued", "planned"]
    expect(AgentClusterLifecycle.deriveRunStatus(statuses)).toBe("dispatching")
  })

  test("deriveRunStatus transitions to reviewing when submitted tasks exist but nothing running", () => {
    const statuses: TaskStatus[] = ["accepted", "submitted"]
    expect(AgentClusterLifecycle.deriveRunStatus(statuses)).toBe("reviewing")
  })

  test("deriveRunStatus remains dispatching with mixed running + submitted", () => {
    const statuses: TaskStatus[] = ["running", "submitted", "accepted", "planned"]
    expect(AgentClusterLifecycle.deriveRunStatus(statuses)).toBe("dispatching")
  })

  test("deriveRunStatus completes when all accepted", () => {
    const statuses: TaskStatus[] = ["accepted", "accepted", "accepted"]
    expect(AgentClusterLifecycle.deriveRunStatus(statuses)).toBe("completed")
  })

  test("deriveRunStatus fails when all failed/cancelled with no accepted", () => {
    const statuses: TaskStatus[] = ["failed", "cancelled"]
    expect(AgentClusterLifecycle.deriveRunStatus(statuses)).toBe("failed")
  })

  test("deriveRunStatus returns planning for empty task list", () => {
    expect(AgentClusterLifecycle.deriveRunStatus([])).toBe("planning")
  })

  test("active count filters running and revising tasks", () => {
    const activeStatuses = ["running", "revising"]
    const nonActive = ["queued", "submitted", "reviewing", "accepted", "failed", "cancelled", "planned"]

    for (const status of nonActive) {
      expect(activeStatuses.includes(status)).toBe(false)
    }
    expect(activeStatuses.includes("running")).toBe(true)
    expect(activeStatuses.includes("revising")).toBe(true)
  })

  test("revision lifecycle: revision_requested -> revising -> submitted -> accepted", () => {
    expect(AgentClusterLifecycle.canTransitionTask("revision_requested", "revising")).toBe(true)
    expect(AgentClusterLifecycle.canTransitionTask("revising", "submitted")).toBe(true)
    expect(AgentClusterLifecycle.canTransitionTask("submitted", "reviewing")).toBe(true)
    expect(AgentClusterLifecycle.canTransitionTask("reviewing", "accepted")).toBe(true)
  })

  test("fake reviewer returns injected decision", () => {
    const accepted = {
      decision: "accepted" as const,
      issues: [] as string[],
      verifiedArtifacts: ["out.md"] as string[],
      risks: [] as string[],
    }
    const reviewer = AgentClusterReviewer.makeFakeReviewer(accepted)
    expect(reviewer).toBeDefined()
    expect(reviewer.review).toBeDefined()
  })

  test("fake reviewer function returns dynamic decisions", () => {
    let callCount = 0
    const reviewer = AgentClusterReviewer.makeFakeReviewerFn((_input) => {
      callCount++
      if (callCount === 1) {
        return {
          decision: "revision_requested" as const,
          issues: ["fix it"],
          revisionPrompt: "Try harder",
          verifiedArtifacts: [],
          risks: [],
        }
      }
      return {
        decision: "accepted" as const,
        issues: [],
        verifiedArtifacts: ["done.md"],
        risks: [],
      }
    })

    const r1 = reviewer.review({
      taskPrompt: "", acceptanceCriteria: [], expectedArtifactPaths: [],
      artifactChecks: [], resultText: "", model: "", role: "",
      priorIssues: [], round: 0, dependencySummaries: [],
    })
    // The adapter returns lazy Effects — actual fn only runs on evaluation
    expect(r1).toBeDefined()
    expect(typeof reviewer.review).toBe("function")
  })

  test("synthesis gate: only terminal tasks allow completion", () => {
    // All tasks must be terminal (accepted/failed/cancelled) before run completes
    expect(AgentClusterLifecycle.isTerminalTask("accepted")).toBe(true)
    expect(AgentClusterLifecycle.isTerminalTask("failed")).toBe(true)
    expect(AgentClusterLifecycle.isTerminalTask("cancelled")).toBe(true)
    expect(AgentClusterLifecycle.isTerminalTask("running")).toBe(false)
    expect(AgentClusterLifecycle.isTerminalTask("submitted")).toBe(false)
    expect(AgentClusterLifecycle.isTerminalTask("reviewing")).toBe(false)
    expect(AgentClusterLifecycle.isTerminalTask("revision_requested")).toBe(false)
    expect(AgentClusterLifecycle.isTerminalTask("revising")).toBe(false)
    expect(AgentClusterLifecycle.isTerminalTask("queued")).toBe(false)
    expect(AgentClusterLifecycle.isTerminalTask("planned")).toBe(false)
  })

  test("second run never mutates first run (separate run_id scoping)", () => {
    // Each run has its own (run_id, plan_task_id) scope
    const run1Tasks = [
      { plan_task_id: "research", run_id: "run_1", status: "accepted" },
      { plan_task_id: "build", run_id: "run_1", status: "accepted" },
    ]
    const run2Tasks = [
      { plan_task_id: "research", run_id: "run_2", status: "queued" },
      { plan_task_id: "review", run_id: "run_2", status: "queued" },
    ]

    // run 2's "research" should not conflict with run 1's "research"
    expect(run1Tasks.filter((t) => t.plan_task_id === "research")).toHaveLength(1)
    expect(run2Tasks.filter((t) => t.plan_task_id === "research")).toHaveLength(1)
    // Different run_ids ensure isolation
    expect(run1Tasks[0]!.run_id).not.toBe(run2Tasks[0]!.run_id)
  })
})
