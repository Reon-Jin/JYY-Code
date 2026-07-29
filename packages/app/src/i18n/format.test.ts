import { describe, expect, it } from "vitest"
import { formatMessage } from "./format"

describe("formatMessage", () => {
  it("does not crash the UI when a runtime translation is unavailable", () => {
    expect(formatMessage(undefined, { name: "JYYCode" })).toBe("")
  })
})
