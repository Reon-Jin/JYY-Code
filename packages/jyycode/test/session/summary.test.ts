import { expect, test } from "bun:test"
import { limitSummaryPatches, MAX_SUMMARY_PATCH_BYTES } from "@/session/summary"

test("keeps diff metadata while bounding patches stored in session summaries", () => {
  const large = "a".repeat(MAX_SUMMARY_PATCH_BYTES)
  const diffs = limitSummaryPatches([
    { file: "drawing.svg", patch: "small", additions: 1, deletions: 0, status: "added" },
    { file: "log/llm-trace.log", patch: large, additions: 12_000, deletions: 0, status: "modified" },
  ])

  expect(diffs[0]?.patch).toBe("small")
  expect(diffs[1]).toEqual({
    file: "log/llm-trace.log",
    patch: undefined,
    additions: 12_000,
    deletions: 0,
    status: "modified",
  })
})
