import { describe, expect, test } from "bun:test"
import { ExecutionBudgetError, budgetFor, resolveExecutionBudget } from "@/execution/budget"

describe("ExecutionBudget", () => {
  test("chooses the minimum of default/requested/hard-cap/parent remaining", () => {
    let now = 0
    const parent = resolveExecutionBudget({ operationClass: "child_agent", requestedMs: 1000, now: () => now })
    now = 250
    const child = resolveExecutionBudget({
      operationClass: "generic_tool",
      requestedMs: 900,
      parent,
      now: () => now,
    })
    expect(child.effectiveMs).toBe(750)
    expect(child.deadline.expiresAt).toBe(1000)
  })

  test("rejects values that could bypass the cap", () => {
    expect(() => budgetFor("generic_tool", Number.NaN)).toThrow(ExecutionBudgetError)
    expect(() => budgetFor("generic_tool", Number.POSITIVE_INFINITY)).toThrow(ExecutionBudgetError)
    expect(() => budgetFor("generic_tool", -1)).toThrow(ExecutionBudgetError)
  })

  test("agent requests cannot enlarge a hard cap", () => {
    const budget = budgetFor("plugin_hook", 24 * 60 * 60 * 1000)
    expect(budget.effectiveMs).toBe(60_000)
    expect(budget.hardCapMs).toBe(60_000)
  })

  test("child() reuses the parent's monotonic clock", () => {
    let now = 0
    const parent = resolveExecutionBudget({ operationClass: "generic_tool", requestedMs: 2000, now: () => now })
    now = 100
    const child = parent.child("plugin_hook", 500)
    expect(child.effectiveMs).toBe(500)
    now = 200
    expect(child.remaining()).toBe(400)
  })
})
