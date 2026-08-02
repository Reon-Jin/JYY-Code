import { describe, expect, it } from "vitest"
import type { SessionPlanResponse } from "@jyycode-ai/sdk/v2/client"
import { findTaskByChildSessionID, projectPlanState } from "./plan-state"

const snapshot: SessionPlanResponse = {
  title: "重构",
  goal: "完成重构",
  status: "active",
  revision: 2,
  current_step: "s1",
  pending_review: 1,
  inbox_pending: 0,
  steps: [
    {
      id: "s1",
      title: "实现",
      status: "active",
      tasks: [
        {
          id: "s1_t1",
          title: "编码",
          status: "running",
          child: { session_id: "ses_child", elapsed_sec: 12, last_activity: "执行测试" },
        },
        { id: "s1_t2", title: "审核", status: "reported" },
      ],
    },
    { id: "s2", title: "验收", status: "pending", tasks: [] },
  ],
}

describe("projectPlanState", () => {
  it("projects the new plan snapshot without reconstructing a legacy task graph", () => {
    const result = projectPlanState(snapshot)
    expect(result.totalSteps).toBe(2)
    expect(result.currentStep).toBe(1)
    expect(result.currentStepID).toBe("s1")
    expect(result.runningAgents).toBe(2)
    expect(result.steps[0]?.id).toBe("s1")
    expect(result.steps[0]?.title).toBe("\u5b9e\u73b0")
    expect(result.steps[1]?.tasks).toEqual([])
    expect(findTaskByChildSessionID(result, "ses_child")?.lastEvent).toBe("执行测试")
  })

  it("returns an empty projection when no plan exists", () => {
    expect(projectPlanState({ plan: null })).toMatchObject({ tasks: [], steps: [], totalAgents: 0 })
  })

  it("does not invent a current step after a plan is complete", () => {
    const result = projectPlanState({ ...snapshot, status: "done", current_step: null as unknown as string })

    expect(result.currentStepID).toBe("")
    expect(result.currentStep).toBe(0)
  })
})
