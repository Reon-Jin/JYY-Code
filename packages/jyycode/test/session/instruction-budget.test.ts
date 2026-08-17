import { describe, expect, test } from "bun:test"
import { budgetInstructions, InstructionBudgetError, remoteReadBounded } from "@/session/instruction-budget"

const candidate = (source: string, content: string, required = false) => ({
  source,
  content,
  bytes: Buffer.byteLength(content),
  digest: "digest-" + source,
  required,
})

describe("instruction budget", () => {
  test("fails closed for an oversized required instruction", () => {
    expect(() =>
      budgetInstructions([candidate("AGENTS.md", "x".repeat(331 * 1024), true)], { maxFileBytes: 256 * 1024 }),
    ).toThrow(InstructionBudgetError)
  })

  test("keeps ordinary oversized content as an explicit manifest and excerpt", () => {
    const result = budgetInstructions([candidate("notes.md", "ordinary\n".repeat(100_000))], {
      maxFileBytes: 256 * 1024,
      maxTokens: 16_000,
      excerptBytes: 32,
    })
    expect(result.entries[0]?.included).toBe(true)
    expect(result.entries[0]?.oversized).toBe(true)
    expect(result.entries[0]?.content).toContain("digest=digest-notes.md")
    expect(result.entries[0]?.content).toContain("included_range=0:32")
  })

  test("bounds chunked remote input without Content-Length", () => {
    const read = remoteReadBounded(
      [new TextEncoder().encode("a".repeat(200_000)), new TextEncoder().encode("b".repeat(200_000))],
      256 * 1024,
    )
    expect(read.bytes).toBe(400_000)
    expect(Buffer.byteLength(read.content)).toBe(256 * 1024)
    expect(read.digest).toHaveLength(64)
  })

  test("omits later normal documents when the total token budget is exhausted", () => {
    const result = budgetInstructions([candidate("one.md", "a".repeat(100)), candidate("two.md", "b".repeat(100))], {
      maxTokens: 30,
      safetyMargin: 0,
    })
    expect(result.entries[0]?.source).toBe("one.md")
    expect(result.entries[1]?.included).toBe(false)
  })
})
