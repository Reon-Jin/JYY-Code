import type { SessionAgentClusterResponse } from "@jyycode-ai/sdk/v2/client"
import { cleanup, render, screen } from "@solidjs/testing-library"
import userEvent from "@testing-library/user-event"
import { afterEach, describe, expect, it, vi } from "vitest"
import { MultiAgentPanelView } from "./multi-agent-panel"
import { projectAgentClusterState } from "./multi-agent-state"

type Task = SessionAgentClusterResponse["tasks"][number]
const task = (overrides: Partial<Task> = {}): Task => ({
  id: "task",
  session_id: "ses_root",
  origin_message_id: "msg",
  parent_task_id: "",
  child_session_id: "",
  role: "coder",
  title: "Implement Mission Control",
  prompt: "Implement",
  complexity: "complex",
  model: "test/coder",
  status: "running",
  step: 2,
  dependencies: [],
  review_round: 0,
  acceptance_criteria: [],
  artifact_paths: [],
  result_summary: "",
  review_issues: [],
  last_event: "running",
  time_created: 1,
  time_updated: 1,
  ...overrides,
})
afterEach(cleanup)

describe("MultiAgentPanelView", () => {
  it("renders session-wide waves, status matrix, and an active child card", async () => {
    const user = userEvent.setup()
    const onOpenChild = vi.fn()
    const snapshot = projectAgentClusterState({
      tasks: [
        task({ id: "done", step: 1, status: "accepted", title: "Plan Mission Control" }),
        task({ child_session_id: "ses_child" }),
        task({
          id: "stopped",
          step: 3,
          status: "interrupted",
          title: "Validate Mission Control",
          review_issues: ["User redirected this worker"],
        }),
      ],
    })
    render(() => (
      <MultiAgentPanelView
        sessionID="ses_root"
        enabled
        snapshot={snapshot}
        selectedChildSessionID="ses_child"
        onOpenChild={onOpenChild}
      />
    ))
    expect(screen.getByText("Implement Mission Control").closest("li")).toHaveAttribute("data-tone", "running")
    expect(screen.getByText("Implement Mission Control").closest("li")).toHaveAttribute("data-selected", "true")
    const toggle = screen.getByRole("button", { name: "Toggle Wave 2" })
    expect(toggle).toHaveAttribute("aria-expanded", "true")
    await user.click(toggle)
    expect(toggle).toHaveAttribute("aria-expanded", "false")
    expect(screen.queryByText("Implement Mission Control")).not.toBeInTheDocument()
    await user.click(toggle)
    expect(screen.getByText("Implement Mission Control")).toBeVisible()
    expect(screen.getByText("已中断")).toBeVisible()
    await user.click(screen.getByRole("button", { name: "审阅：Implement Mission Control" }))
    expect(onOpenChild).toHaveBeenCalledWith("ses_child")
  })
})
