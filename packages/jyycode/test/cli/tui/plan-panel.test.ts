import { describe, expect, test } from "bun:test"
import {
  projectPlanState,
  emptyPlanSnapshot,
  type PlanSnapshot,
} from "../../../src/cli/cmd/tui/feature-plugins/system/plan-panel"
import type { SessionPlanResponse } from "@jyycode-ai/sdk/v2"

describe("projectPlanState", () => {
  test("空 plan → 空态", () => {
    const state = projectPlanState({ plan: null })
    expect(state.totalSteps).toBe(0)
    expect(state.tasks).toHaveLength(0)
    expect(emptyPlanSnapshot()).toEqual(state)
  })

  test("task 状态归约：running 计数与完成百分比", () => {
    const state = projectPlanState({
      title: "t",
      goal: "g",
      status: "active",
      revision: 1,
      current_step: "s1",
      steps: [
        {
          id: "s1",
          title: "step1",
          status: "active",
          tasks: [
            { id: "t1", title: "task1", status: "running" },
            { id: "t2", title: "task2", status: "approved" },
          ],
        },
      ],
      pending_review: 0,
      inbox_pending: 0,
    })
    expect(state.totalSteps).toBe(1)
    expect(state.doneAgents).toBe(1)
    expect(state.runningAgents).toBe(1)
    expect(state.completedSteps).toBe(0)
    expect(state.steps[0]!.tone).toBe("running")
    expect(state.steps[0]!.tasks[0]!.statusLabel).toBe("执行中")
    expect(state.steps[0]!.tasks[1]!.statusLabel).toBe("已通过")
  })

  test("step 完成判定：done step 归约为 done", () => {
    const state = projectPlanState({
      title: "t",
      goal: "g",
      status: "done",
      revision: 1,
      current_step: "",
      steps: [
        {
          id: "s1",
          title: "step1",
          status: "done",
          tasks: [{ id: "t1", title: "task1", status: "approved" }],
        },
      ],
      pending_review: 0,
      inbox_pending: 0,
    })
    expect(state.completedSteps).toBe(1)
    expect(state.steps[0]!.tone).toBe("done")
  })

  test("child session 映射", () => {
    const snapshot: PlanSnapshot = projectPlanState({
      title: "t",
      goal: "g",
      status: "active",
      revision: 1,
      current_step: "s1",
      steps: [
        {
          id: "s1",
          title: "s",
          status: "active",
          tasks: [{ id: "t1", title: "x", status: "running", child: { session_id: "child-1", elapsed_sec: 5 } }],
        },
      ],
      pending_review: 0,
      inbox_pending: 0,
    })
    expect(snapshot.tasks[0]!.childSessionID).toBe("child-1")
  })
})
