import { expect, test } from "bun:test"

import BASE_POLICY from "../../src/session/prompt/default.txt"
import { composeAgentSystemPrompt } from "../../src/session/llm/request"
import { PLAN_CHILD_PROMPT, planSystemPrompt } from "../../src/plan/prompts"
import { RUNTIME_CONTRACT } from "../../src/session/system"

test("interactive role prompts augment the canonical base policy", () => {
  const prompt = composeAgentSystemPrompt({
    name: "subagent:reviewer",
    mode: "subagent",
    prompt: "Review the delegated changes.",
  })

  expect(prompt).toContain("Runtime permissions, visible tools")
  expect(prompt).toContain("Review the delegated changes.")
})

test("internal utility prompts remain isolated from the interactive base policy", () => {
  const prompt = composeAgentSystemPrompt({
    name: "compaction",
    mode: "primary",
    prompt: "Summarize this conversation.",
  })

  expect(prompt).toBe("Summarize this conversation.")
})

test("the runtime contract gives every request memory and context retrieval rules", () => {
  expect(RUNTIME_CONTRACT).toContain("Task state is updated by the runtime")
  expect(RUNTIME_CONTRACT).toContain("context_read(action=experience)")
  expect(RUNTIME_CONTRACT).toContain("Only the root session may change persistent memory")
})

test("prompt layers remain within their explicit character budgets", () => {
  expect(BASE_POLICY.length).toBeLessThanOrEqual(2_400)
  expect(PLAN_CHILD_PROMPT.length).toBeLessThanOrEqual(1_600)
  expect(planSystemPrompt({ child: false, multiAgent: true, profiles: [] }).length).toBeLessThanOrEqual(3_500)
  // Single-agent roots carry no plan protocol section.
  expect(planSystemPrompt({ child: false, multiAgent: false })).toBe("")
})

test("child protocol is artifact-first and never offers root plan mutation", () => {
  expect(PLAN_CHILD_PROMPT).toContain("Write the requested artifact first")
  expect(PLAN_CHILD_PROMPT).not.toContain("Plan_create")
  expect(PLAN_CHILD_PROMPT).not.toContain("Dispatch_dispatch")
})
