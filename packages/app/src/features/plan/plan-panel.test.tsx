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
})
