import { describe, expect, it } from "bun:test"
import { childLaunchParts, childRetryPrompt, childRetryPrompts } from "../../src/plan/tools"
import type { DispatchBrief } from "../../src/plan/protocol"

function brief(): DispatchBrief {
  return {
    run_id: "run__ses_root__s1_t1",
    task_title: "Write the notes",
    goal: "write the notes",
    done_criteria: "notes.md exists",
    task_instructions: "Read src/api.ts and document every public endpoint.",
    workspace_root: "/workspace",
    output_path: "/workspace/notes.md",
    previous_feedback: {
      review_feedback: "Add the missing API examples.",
      issues: ["The current document still omits the error response."],
    },
    review_feedback_history: [
      {
        review_feedback: "Add the missing API examples.",
        issues: ["The current document still omits the error response."],
      },
      {
        review_feedback: "Also cover the pagination edge case.",
        issues: ["The second revision still has no pagination example."],
      },
    ],
    step_context: {
      plan_goal: "Document the API",
      step_id: "s1",
      step_title: "API analysis",
      step_goal: "Create reliable API documentation",
      step_done_criteria: "Docs cover every endpoint",
    },
    report_format: "Report(...)",
    step_directory: [],
  }
}

const role = {
  id: "worker",
  name: "Worker",
  description: "Worker",
  prompt: "Use a careful implementation.",
  avatar: "bot" as const,
}

describe("multi-agent review retry prompts", () => {
  it("emits one follow-up prompt for every persisted review round", () => {
    const prompts = childRetryPrompts(brief())

    expect(prompts).toHaveLength(2)
    expect(prompts[0]).toContain("Add the missing API examples.")
    expect(prompts[1]).toContain("Also cover the pagination edge case.")
    expect(childRetryPrompt(brief())).toContain("Also cover the pagination edge case.")
    expect(childRetryPrompt(brief())).toContain("run__ses_root__s1_t1")
    expect(childRetryPrompt(brief())).toContain("Do not reuse the run_id from the original dispatch brief")
  })

  it("keeps all review feedback out of the initial task prompt and metadata", () => {
    const parts = childLaunchParts(brief(), role)

    expect(parts[0]?.text).toContain("Read src/api.ts")
    expect(parts[0]?.text).not.toContain("Add the missing API examples.")
    expect(parts[0]?.text).not.toContain("Also cover the pagination edge case.")
    expect(parts[1]?.text).not.toContain("review_feedback_history")
    expect(parts[1]?.text).not.toContain("Add the missing API examples.")
  })
})
