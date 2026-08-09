import { describe, expect, test } from "bun:test"
import { parseDuration, retentionDecision } from "@/storage/retention"

describe("storage retention policy", () => {
  test("preserves roots and unknown lifecycle states", () => {
    expect(retentionDecision({ root: true, lifecycle: "terminal" }).action).toBe("preserve")
    expect(retentionDecision({ lifecycle: "unknown" }).reason).toBe("unknown-lifecycle")
    expect(retentionDecision({ artifact: "backup" }).automatic).toBe(false)
  })

  test("preserves active, leased, and waiting sessions", () => {
    for (const lifecycle of ["active", "leased", "waiting_permission", "waiting_question"] as const) {
      const result = retentionDecision({ lifecycle, updatedAt: 0, now: 100_000_000, terminalChildTtlMs: 1 })
      expect(result.action).toBe("preserve")
    }
  })

  test("only expired terminal children are eligible for payload pruning", () => {
    expect(
      retentionDecision({ lifecycle: "terminal", updatedAt: 0, now: 31, terminalChildTtlMs: 30 }),
    ).toEqual({ action: "prune_payload", reason: "terminal-child-expired", automatic: true })
    expect(retentionDecision({ lifecycle: "terminal", updatedAt: 10, now: 20, terminalChildTtlMs: 30 }).action).toBe(
      "preserve",
    )
  })

  test("parses bounded cleanup durations", () => {
    expect(parseDuration("30d")).toBe(30 * 24 * 60 * 60 * 1000)
    expect(parseDuration("1.5h")).toBe(5_400_000)
    expect(() => parseDuration("forever")).toThrow()
  })
})
