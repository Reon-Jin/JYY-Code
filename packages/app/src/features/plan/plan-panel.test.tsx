import { cleanup, render, screen } from "@solidjs/testing-library"
import userEvent from "@testing-library/user-event"
import { afterEach, describe, expect, it } from "vitest"
import { MultiAgentPanelView } from "../multi-agent/multi-agent-panel"
import type { MultiAgentSnapshot } from "./plan-state"

function snapshot(): MultiAgentSnapshot {
  const tasks: MultiAgentSnapshot["tasks"] = [
    {
      key: "task_assigned",
      id: "task_assigned",
      step: 1,
      role: { id: "reviewer", name: "Reviewer", description: "Checks delegated work.", avatar: "code" },
      title: "Review the patch",
      model: "openai/gpt-5",
      status: "running",
      tone: "running",
      statusLabel: "Running",
      dependencies: [],
      acceptanceCriteria: [],
      artifactPaths: [],
      reviewIssues: [],
      reviewRound: 0,
      elapsedMs: 1,
      childSessionID: "child_review",
    },
    {
      key: "task_unassigned",
      id: "task_unassigned",
      step: 1,
      title: "Await assignment",
      model: "",
      status: "pending",
      tone: "queued",
      statusLabel: "Planned",
      dependencies: [],
      acceptanceCriteria: [],
      artifactPaths: [],
      reviewIssues: [],
      reviewRound: 0,
      elapsedMs: 0,
    },
  ]
  return {
    steps: [
      {
        id: "s1",
        index: 1,
        title: "Implementation",
        tone: "running",
        collapsed: false,
        tasks,
      },
    ],
    tasks,
    totalAgents: 2,
    runningAgents: 1,
    doneAgents: 0,
    failedAgents: 0,
    interruptedAgents: 0,
    totalSteps: 1,
    currentStepID: "s1",
    currentStep: 1,
    completedSteps: 0,
  }
}

afterEach(cleanup)

describe("Plan role presentation", () => {
  it("renders the frozen role name and shared avatar, with neutral unassigned copy", async () => {
    const user = userEvent.setup()
    render(() => (
      <MultiAgentPanelView
        sessionID="ses_root"
        enabled
        snapshot={snapshot()}
        onOpenChild={() => undefined}
      />
    ))

    await user.click(screen.getByText("Review the patch"))
    expect(screen.getByText("Reviewer")).toBeVisible()
    expect(screen.getByLabelText("Reviewer")).toHaveAttribute("data-avatar", "code")
    expect(screen.getByLabelText("未分配")).toBeVisible()
    expect(screen.queryByText("通用")).not.toBeInTheDocument()
  })

  it("preserves the wave expansion and scroll position when reviewing a child", async () => {
    const user = userEvent.setup()
    const rootSessionID = "ses_plan_state_preservation"
    let opened: string | undefined
    render(() => (
      <MultiAgentPanelView
        sessionID={rootSessionID}
        enabled
        snapshot={snapshot()}
        onOpenChild={(sessionID) => {
          opened = sessionID
        }}
      />
    ))

    const body = document.querySelector<HTMLElement>(".multi-agent-panel__body")
    expect(body).not.toBeNull()
    body!.scrollTop = 240
    body!.dispatchEvent(new Event("scroll"))
    const toggle = document.querySelector<HTMLButtonElement>(".multi-agent-step__toggle")
    expect(toggle).not.toBeNull()
    await user.click(toggle!)
    expect(toggle).toHaveAttribute("aria-expanded", "false")

    // Collapsed steps hide their task rows, so expand again to reach the review button.
    await user.click(toggle!)
    expect(toggle).toHaveAttribute("aria-expanded", "true")
    await user.click(screen.getByRole("button", { name: /审阅|review/i }))
    expect(opened).toBe("child_review")
    await user.click(toggle!)
    expect(toggle).toHaveAttribute("aria-expanded", "false")

    cleanup()
    render(() => (
      <MultiAgentPanelView
        sessionID={rootSessionID}
        enabled
        snapshot={snapshot()}
        onOpenChild={() => undefined}
      />
    ))
    await Promise.resolve()
    const restoredToggle = document.querySelector<HTMLButtonElement>(".multi-agent-step__toggle")
    const restoredBody = document.querySelector<HTMLElement>(".multi-agent-panel__body")
    expect(restoredToggle).toHaveAttribute("aria-expanded", "false")
    expect(restoredBody?.scrollTop).toBe(240)
  })
})
