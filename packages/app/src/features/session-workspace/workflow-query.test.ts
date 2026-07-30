import { describe, expect, it, vi } from "vitest"
import { publishSessionBlackboard, selectSessionWorkflow } from "./workflow-query"

describe("selectSessionWorkflow", () => {
  it("sends the selected workflow as the pin endpoint request body", async () => {
    const pin = vi.fn(async () => ({ data: true }))

    await selectSessionWorkflow({
      client: { workflow: { pin } } as any,
      directory: "C:\\work\\demo",
      sessionID: "ses_workflow",
      workflowID: "workflow-creation",
      workflowVersion: "2.0.0",
    })

    expect(pin).toHaveBeenCalledWith(
      {
        directory: "C:\\work\\demo",
        sessionID: "ses_workflow",
        workflowID: "workflow-creation",
        workflowVersion: "2.0.0",
      },
      { throwOnError: true },
    )
  })

  it("publishes a newly created blackboard card so other agents can read it", async () => {
    const createBlackboard = vi.fn(async () => ({ data: { id: "blackboard_1", status: "draft" } }))
    const transitionBlackboard = vi.fn(async () => ({ data: { id: "blackboard_1", status: "published" } }))
    const card = {
      type: "decision" as const,
      title: "保留现有接口",
      authorAgentID: "主智能体",
      summary: "需要兼容已有会话数据。",
      relatedTasks: [],
      replaces: [],
      impactScope: "medium" as const,
      artifacts: [],
    }

    await publishSessionBlackboard({
      client: { workflow: { createBlackboard, transitionBlackboard } } as any,
      directory: "C:\\work\\demo",
      sessionID: "ses_workflow",
      card,
    })

    expect(createBlackboard).toHaveBeenCalledWith(
      { directory: "C:\\work\\demo", sessionID: "ses_workflow", ...card },
      { throwOnError: true },
    )
    expect(transitionBlackboard).toHaveBeenCalledWith(
      { directory: "C:\\work\\demo", cardID: "blackboard_1", from: "draft", to: "published" },
      { throwOnError: true },
    )
  })
})
