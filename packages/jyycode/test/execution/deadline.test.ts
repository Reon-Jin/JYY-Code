import { describe, expect, test } from "bun:test"
import { Deadline, combineAbortSignals } from "@/execution/deadline"

describe("Deadline", () => {
  test("uses a monotonic clock and never lets a child outlive its parent", () => {
    let now = 100
    const clock = () => now
    const parent = Deadline.fromDuration(1000, { now: clock })
    now = 400
    const child = parent.child(900)
    expect(child.expiresAt).toBe(1100)
    now = 1200
    expect(parent.expired()).toBe(true)
    expect(child.expired()).toBe(true)
  })

  test("rejects invalid durations", () => {
    expect(() => Deadline.fromDuration(Number.NaN)).toThrow()
    expect(() => Deadline.fromDuration(-1)).toThrow()
    expect(() => Deadline.fromDuration(Number.POSITIVE_INFINITY)).toThrow()
  })

  test("combines parent cancellation with deadline cancellation", () => {
    let now = 0
    const parent = new AbortController()
    const signal = Deadline.fromDuration(10, { now: () => now }).signal(parent.signal)
    expect(signal.aborted).toBe(false)
    parent.abort(new Error("cancelled"))
    expect(signal.aborted).toBe(true)
  })

  test("combines multiple signals and preserves the first reason", () => {
    const first = new AbortController()
    const second = new AbortController()
    const signal = combineAbortSignals(first.signal, second.signal)
    first.abort(new Error("first"))
    second.abort(new Error("second"))
    expect(signal.aborted).toBe(true)
    expect((signal.reason as Error).message).toBe("first")
  })
})
