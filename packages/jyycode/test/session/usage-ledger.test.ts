import { describe, expect, test } from "bun:test"
import { UsageLedger } from "@/session/usage-ledger"

describe("UsageLedger", () => {
  test("keeps current context fields separate from cumulative billing", () => {
    const ledger = new UsageLedger()
    ledger.applyStep(0, { input: 100, output: 20, reasoning: 5, cache: { read: 10, write: 2 } }, 0.1)
    const result = ledger.applyStep(1, { input: 40, output: 30, reasoning: 3, cache: { read: 4, write: 1 } }, 0.2)
    const third = ledger.applyStep(2, { input: 60, output: 10, reasoning: 2, cache: { read: 6, write: 3 } }, 0.3)

    expect(third.context.input).toBe(60)
    expect(third.context.cache.read).toBe(6)
    expect(third.context.output).toBe(60)
    expect(third.context.reasoning).toBe(10)
    expect(third.context.cache.write).toBe(6)
    expect(third.context.total).toBe(142)
    expect(third.billing.input).toBe(200)
    expect(third.billing.cache.read).toBe(20)
    expect(third.billing.total).toBe(296)
    expect(third.cost).toBeCloseTo(0.6)
    expect(result.duplicate).toBe(false)
  })

  test("derives totals and ignores invalid provider numbers", () => {
    const ledger = new UsageLedger()
    const result = ledger.applyStep(
      0,
      {
        total: 99_999,
        input: Number.NaN,
        output: -1,
        reasoning: Number.POSITIVE_INFINITY,
        cache: { read: 5, write: undefined },
      },
      Number.NaN,
    )
    expect(result.context).toEqual({
      input: 0,
      output: 0,
      reasoning: 0,
      cache: { read: 5, write: 0 },
      total: 5,
    })
    expect(result.cost).toBe(0)
  })

  test("is idempotent by provider step index, without numeric heuristics", () => {
    const ledger = new UsageLedger()
    ledger.applyStep(0, { input: 10, output: 1 })
    const duplicate = ledger.applyStep(0, { input: 10_000, output: 10_000 }, 100)
    expect(duplicate.duplicate).toBe(true)
    expect(duplicate.billing.input).toBe(10)
    expect(duplicate.cost).toBe(0)
    expect(() => ledger.applyStep(-1, {})).toThrow()
  })
})
