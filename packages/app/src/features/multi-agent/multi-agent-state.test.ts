import type { SessionAgentClusterResponse } from "@jyycode-ai/sdk/v2/client"
import { describe, expect, it } from "vitest"
import { findTaskByChildSessionID, projectAgentClusterState } from "./multi-agent-state"

type Task = SessionAgentClusterResponse["tasks"][number]
function task(overrides: Partial<Task> = {}): Task {
  return { id: "task_1", session_id: "ses_root", origin_message_id: "msg_1", parent_task_id: "", child_session_id: "", role: "coder", title: "Implement", prompt: "Implement", complexity: "complex", model: "test/coder", status: "planned", step: 1, dependencies: [], review_round: 0, acceptance_criteria: [], artifact_paths: [], result_summary: "", review_issues: [], last_event: "", time_created: 10, time_updated: 10, ...overrides }
}

describe("projectAgentClusterState", () => {
  it("projects an empty session task graph", () => {
    expect(projectAgentClusterState({ tasks: [] })).toMatchObject({ tasks: [], steps: [], totalAgents: 0, currentStep: 0 })
  })

  it("groups durable session steps into completed, active, review, queued, and interrupted waves", () => {
    const snapshot = projectAgentClusterState({ tasks: [
      task({ id: "done", step: 1, status: "accepted" }),
      task({ id: "active", step: 2, status: "running", child_session_id: "ses_child" }),
      task({ id: "review", step: 2, status: "reviewing" }),
      task({ id: "queued", step: 3, status: "queued" }),
      task({ id: "stopped", step: 4, status: "interrupted", review_issues: ["User redirected this worker"] }),
    ] })
    expect(snapshot.steps.map((wave) => [wave.index, wave.tone, wave.collapsed])).toEqual([
      [1, "done", true], [2, "running", false], [3, "queued", false], [4, "interrupted", false],
    ])
    expect(snapshot).toMatchObject({ totalAgents: 5, runningAgents: 2, doneAgents: 1, interruptedAgents: 1, currentStep: 2 })
    expect(snapshot.tasks.find((item) => item.id === "stopped")).toMatchObject({ tone: "interrupted", reviewIssues: ["User redirected this worker"] })
    expect(findTaskByChildSessionID(snapshot, "ses_child")).toMatchObject({ id: "active" })
  })
})
