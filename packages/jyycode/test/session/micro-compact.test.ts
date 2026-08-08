import { describe, expect, test } from "bun:test"
import {
  DEFAULT_MICRO_COMPACT_MAX_CHARS,
  estimateMicroCompactSavings,
  isCompactable,
  microCompactOutput,
} from "../../src/session/micro-compact"

const completed = (output: string) => ({
  type: "tool",
  state: { status: "completed", output },
})

describe("session.micro-compact", () => {
  test("leaves short output unchanged", () => {
    const output = "short output"
    expect(microCompactOutput(output, DEFAULT_MICRO_COMPACT_MAX_CHARS)).toBeNull()
  })

  test("keeps head and tail with exact omission metadata", () => {
    const output = [
      "{",
      '  \"first\": \"preserve this header\",',
      ...Array.from({ length: 80 }, (_, index) => `  \"item${index}\": \"hidden-${index}\",`),
      '  \"last\": \"preserve this footer\"',
      "}",
    ].join("\n")

    const compacted = microCompactOutput(output, 120)
    expect(compacted).not.toBeNull()
    expect(compacted?.content).toContain('{\n  "first": "preserve this header",')
    expect(compacted?.content).toContain('  "last": "preserve this footer"\n}')
    expect(compacted?.content).toMatch(/\[micro-compacted: original \d+ chars; hidden \d+ chars\]/)
    expect(compacted?.content.length).toBeLessThan(output.length)
    expect(microCompactOutput(compacted!.content, 120)).toBeNull()
  })

  test("preserves line boundaries for patches, stacks, and paths", () => {
    const output = [
      "diff --git a/src/example.ts b/src/example.ts",
      "@@ -1,5 +1,5 @@",
      ...Array.from({ length: 70 }, (_, index) => ` at /workspace/src/example.ts:${index + 1}:1`),
      "Error: command failed",
    ].join("\n")

    const compacted = microCompactOutput(output, 100)
    expect(compacted?.content).toContain("diff --git a/src/example.ts b/src/example.ts")
    expect(compacted?.content).toContain("Error: command failed")
    expect(compacted?.content).toContain("/workspace/src/example.ts:")
  })

  test("only completed tool parts are eligible and savings match the result", () => {
    const output = "x".repeat(500)
    const messages = [
      { parts: [completed(output)] },
      { parts: [{ type: "tool", state: { status: "pending" } }] },
      { parts: [{ type: "tool", state: { status: "running" } }] },
      { parts: [{ type: "tool", state: { status: "error", error: output } }] },
    ]
    const compacted = microCompactOutput(output, 100)

    expect(isCompactable(messages[0]!.parts[0])).toBe(true)
    expect(isCompactable(messages[1]!.parts[0])).toBe(false)
    expect(isCompactable(messages[2]!.parts[0])).toBe(false)
    expect(isCompactable(messages[3]!.parts[0])).toBe(false)
    expect(estimateMicroCompactSavings(messages, 100)).toBe(output.length - compacted!.content.length)
  })
})
