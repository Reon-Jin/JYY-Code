import { describe, expect, it } from "vitest"
import type { SessionPlanResponse } from "@jyycode-ai/sdk/v2/client"
import { findTaskByChildSessionID, projectPlanState } from "./plan-state"

const snapshot = {
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
          role: {
            id: "reviewer",
            name: "Reviewer",
            description: "Checks delegated work.",
            avatar: "code",
          },
          child: { session_id: "ses_child", elapsed_sec: 12, last_activity: "执行测试" },
        },
        { id: "s1_t2", title: "审核", status: "reported" },
      ],
    },
    { id: "s2", title: "验收", status: "pending", tasks: [] },
  ],
} as unknown as SessionPlanResponse

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
    expect(result.tasks[0]?.role).toEqual({
      id: "reviewer",
      name: "Reviewer",
      description: "Checks delegated work.",
      avatar: "code",
    })
    expect(result.tasks[1]?.role).toBeUndefined()

    ;(
      snapshot as unknown as { steps: Array<{ tasks: Array<{ role: { name: string } }> }> }
    ).steps[0]!.tasks[0]!.role!.name = "Changed later"
    expect(result.tasks[0]?.role?.name).toBe("Reviewer")
  })

  it("returns an empty projection when no plan exists", () => {
    expect(projectPlanState({ plan: null })).toMatchObject({ tasks: [], steps: [], totalAgents: 0 })
  })

  it("does not invent a current step after a plan is complete", () => {
    const result = projectPlanState({ ...snapshot, status: "done", current_step: null as unknown as string })

    expect(result.currentStepID).toBe("")
    expect(result.currentStep).toBe(0)
  })

  it("projects candidate discussion phases and treats dismissed candidates as settled", () => {
    const planSnapshot = snapshot as Extract<SessionPlanResponse, { steps: unknown[] }>
    const candidate = {
      ...snapshot,
      steps: [
        {
          ...planSnapshot.steps[0],
          candidate: {
            phase: "awaiting_main",
            ready: 2,
            total: 2,
            selection: {
              selected_task_id: "s1_t1",
              contributing_task_ids: ["s1_t2"],
              synthesis_artifact: "docs/synthesis.md",
              rationale: "best fit",
              selected_at: "2026-08-02T00:00:00.000Z",
            },
          },
          tasks: [
            { ...planSnapshot.steps[0]!.tasks[0], mode: "candidate", status: "approved" },
            { ...planSnapshot.steps[0]!.tasks[1], mode: "candidate", status: "dismissed" },
          ],
        },
      ],
    } as unknown as SessionPlanResponse
    const result = projectPlanState(candidate)
    expect(result.steps[0]?.candidate).toMatchObject({ phase: "awaiting_main", ready: 2, total: 2 })
    expect(result.steps[0]?.candidate?.selection).toMatchObject({
      selectedTaskID: "s1_t1",
      contributingTaskIDs: ["s1_t2"],
      synthesisArtifact: "docs/synthesis.md",
    })
    expect(result.tasks[1]?.status).toBe("dismissed")
    expect(result.tasks[1]?.tone).toBe("done")
    expect(result.tasks[1]?.statusLabel).toBeTruthy()
  })
})
