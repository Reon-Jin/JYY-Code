import { expect, test } from "bun:test"

import PROMPT_GENERATE from "../../src/agent/generate.txt"

test("the role generator produces a bounded supplement instead of a platform manual", () => {
  expect(PROMPT_GENERATE).toContain("900 characters")
  expect(PROMPT_GENERATE).toContain("role supplement")
  expect(PROMPT_GENERATE).not.toContain("Task tool")
  expect(PROMPT_GENERATE).not.toContain("complete operational manual")
})
