import type { SessionAgentClusterResponse } from "@jyycode-ai/sdk/v2/client"
import { describe, expect, it } from "vitest"
import { findTaskByChildSessionID, projectAgentClusterState } from "./multi-agent-state"

type Run = SessionAgentClusterResponse["runs"][number]
type Task = SessionAgentClusterResponse["tasks"][number]

function run(overrides: Partial<Run> = {}): Run {
  return {
    id: "run_1",
    session_id: "ses_root",
    parent_message_id: "msg_parent",
    enabled: true,
    status: "planning",
    goal: "Ship Multi-Agent",
    planner_model: "test/planner",
    reviewer_model: "test/reviewer",
    time_created: 10,
    time_updated: 10,
    completed_at: 0,
    ...overrides,
  }
}

function task(overrides: Partial<Task> = {}): Task {
  return {
    id: "task_1",
    run_id: "run_1",
    parent_task_id: "",
    child_session_id: "",
    role: "coder",
    title: "Implement",
    prompt: "Implement the feature",
    complexity: "complex",
    model: "test/coder",
    status: "planned",
    step: 1,
    dependencies: [],
    review_round: 0,
    acceptance_criteria: ["Tests pass"],
    artifact_paths: [],
    result_summary: "",
    review_issues: [],
    last_event: "",
    time_created: 11,
    time_updated: 11,
    ...overrides,
  }
}

describe("projectAgentClusterState", () => {
  it("projects an empty state", () => {
    expect(projectAgentClusterState({ runs: [], tasks: [] })).toEqual({
      runs: [],
      steps: [],
      tasks: [],
      latestRun: undefined,
      latestGoal: undefined,
      totalAgents: 0,
      runningAgents: 0,
      doneAgents: 0,
      failedAgents: 0,
      totalSteps: 0,
      currentStep: 0,
      completedSteps: 0,
    })
  })

  it("keeps a planning run visible before tasks exist", () => {
    const snapshot = projectAgentClusterState({ runs: [run()], tasks: [] })

    expect(snapshot.latestGoal).toBe("Ship Multi-Agent")
    expect(snapshot.runs[0]).toMatchObject({ id: "run_1", status: "planning", statusLabel: "规划中" })
    expect(snapshot.steps).toEqual([])
  })

  it.each([
    ["planning", "规划中"],
    ["dispatching", "派发中"],
    ["reviewing", "复核中"],
    ["synthesizing", "汇总中"],
    ["completed", "已完成"],
    ["failed", "失败"],
    ["cancelled", "已取消"],
  ] as const)("preserves run status %s with a readable label", (status, statusLabel) => {
    const snapshot = projectAgentClusterState({ runs: [run({ status })], tasks: [] })
    expect(snapshot.runs[0]).toMatchObject({ status, statusLabel })
  })

  it.each([
    ["planned", "queued", "已规划"],
    ["queued", "queued", "排队中"],
    ["running", "running", "运行中"],
    ["revising", "running", "修改中"],
    ["submitted", "review", "已提交"],
    ["reviewing", "review", "复核中"],
    ["revision_requested", "review", "需要修改"],
    ["accepted", "done", "已通过"],
    ["failed", "failed", "失败"],
    ["cancelled", "failed", "已取消"],
  ] as const)("maps task status %s to %s without losing its exact label", (status, tone, statusLabel) => {
    const snapshot = projectAgentClusterState({ runs: [run()], tasks: [task({ status })] })
    expect(snapshot.tasks[0]).toMatchObject({ status, tone, statusLabel })
  })

  it("sorts runs chronologically and flattens local steps into one session timeline", () => {
    const state: SessionAgentClusterResponse = {
      runs: [
        run({ id: "run_2", goal: "Second", time_created: 30 }),
        run({ id: "run_1", goal: "First", time_created: 10 }),
      ],
      tasks: [
        task({ id: "verify", run_id: "run_2", step: 1, time_created: 31, status: "running" }),
        task({ id: "build", run_id: "run_1", step: 2, time_created: 12, status: "accepted" }),
        task({ id: "plan", run_id: "run_1", step: 1, time_created: 11, status: "accepted" }),
      ],
    }

    const snapshot = projectAgentClusterState(state)

    expect(snapshot.runs.map((item) => item.id)).toEqual(["run_1", "run_2"])
    expect(snapshot.steps.map((step) => [step.index, step.runID, step.localStep])).toEqual([
      [1, "run_1", 1],
      [2, "run_1", 2],
      [3, "run_2", 1],
    ])
    expect(snapshot.tasks.map((item) => [item.id, item.step])).toEqual([
      ["plan", 1],
      ["build", 2],
      ["verify", 3],
    ])
    expect(snapshot.latestGoal).toBe("Second")
    expect(snapshot.currentStep).toBe(3)
  })

  it("qualifies duplicate task and dependency IDs within their run", () => {
    const state: SessionAgentClusterResponse = {
      runs: [run({ id: "run_1" }), run({ id: "run_2", time_created: 20 })],
      tasks: [
        task({ id: "research", run_id: "run_1" }),
        task({ id: "write", run_id: "run_1", step: 2, dependencies: ["research"] }),
        task({ id: "research", run_id: "run_2", time_created: 21 }),
        task({ id: "publish", run_id: "run_2", step: 2, dependencies: ["research", "write"] }),
      ],
    }

    const snapshot = projectAgentClusterState(state)

    expect(snapshot.tasks.map((item) => item.key)).toEqual([
      "run_1:research",
      "write",
      "run_2:research",
      "publish",
    ])
    expect(snapshot.tasks.find((item) => item.id === "write")?.dependencies).toEqual(["run_1:research"])
    expect(snapshot.tasks.find((item) => item.id === "publish")?.dependencies).toEqual([
      "run_2:research",
      "write",
    ])
  })

  it("derives agent and step counts and finds the selected child task", () => {
    const state: SessionAgentClusterResponse = {
      runs: [run({ status: "dispatching" })],
      tasks: [
        task({ id: "done", status: "accepted", step: 1 }),
        task({ id: "active", status: "running", step: 2, child_session_id: "ses_child" }),
        task({ id: "review", status: "reviewing", step: 2 }),
        task({ id: "failed", status: "failed", step: 3 }),
        task({ id: "queued", status: "queued", step: 4 }),
      ],
    }

    const snapshot = projectAgentClusterState(state)

    expect(snapshot).toMatchObject({
      totalAgents: 5,
      runningAgents: 2,
      doneAgents: 1,
      failedAgents: 1,
      totalSteps: 4,
      currentStep: 2,
      completedSteps: 1,
    })
    expect(findTaskByChildSessionID(snapshot, "ses_child")).toMatchObject({ id: "active", childSessionID: "ses_child" })
    expect(findTaskByChildSessionID(snapshot, "ses_missing")).toBeUndefined()
  })
})
