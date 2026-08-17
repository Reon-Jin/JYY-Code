import { describe, expect, test } from "bun:test"
import { decodeStoredJSONRow, MAX_SESSION_ROW_BYTES } from "@/session/row-decoder"

describe("session row decoder", () => {
  test("decodes valid JSON and records stable diagnostics for invalid rows", () => {
    const valid = decodeStoredJSONRow({
      table: "message",
      id: "m1",
      data: JSON.stringify({ ok: true }),
      decode: (value) => value,
    })
    expect(valid).toEqual({ value: { ok: true } })
    const invalid = decodeStoredJSONRow({ table: "message", id: "m2", data: "{", decode: (value) => value })
    expect("error" in invalid && invalid.error.reason).toBe("invalid-json")
    expect("error" in invalid && invalid.error.digest).toHaveLength(64)
  })

  test("rejects oversized rows before schema work", () => {
    let decoded = false
    const result = decodeStoredJSONRow({
      table: "part",
      id: "p1",
      data: JSON.stringify({ output: "x".repeat(MAX_SESSION_ROW_BYTES + 1) }),
      decode: () => {
        decoded = true
        return true
      },
    })
    expect("error" in result && result.error.reason).toBe("oversized")
    expect(decoded).toBe(false)
  })
})
