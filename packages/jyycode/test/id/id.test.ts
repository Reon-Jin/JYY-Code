import { describe, expect, test } from "bun:test"
import { Identifier } from "../../src/id/id"

describe("Identifier", () => {
  test("ascending IDs are 30 chars with a 16-char time hex field", () => {
    const id = Identifier.ascending("message")
    expect(id.startsWith("msg_")).toBe(true)
    expect(id).toHaveLength(4 + 30)
    expect(id.slice(4, 20)).toMatch(/^[0-9a-f]{16}$/)
  })

  test("IDs generated with increasing timestamps sort ascending across the old wrap boundary", () => {
    // 26 * 2^36 ms = 2026-08-14T11:19:55.136Z, where the old 6-byte field wrapped.
    const boundary = 26n * (1n << 36n)
    const before = Identifier.create("msg", "ascending", Number(boundary - 1n))
    const after = Identifier.create("msg", "ascending", Number(boundary + 1n))
    expect(after > before).toBe(true)
  })

  test("timestamp() round-trips the creation timestamp", () => {
    const timestamp = Date.now() - 60_000
    const id = Identifier.create("tool", "ascending", timestamp)
    expect(Identifier.timestamp(id)).toBe(timestamp)
  })

  test("timestamp() still decodes legacy 12-hex IDs with the old semantics", () => {
    // Legacy format: (ms mod 2^36) * 4096 + counter in 12 hex chars.
    const ms = 1_750_000_000_000n
    const now = (ms % (1n << 36n)) * 0x1000n + 7n
    const hex = now.toString(16).padStart(12, "0")
    const legacy = `msg_${hex}XYZUVWxyzuvwKLMN`
    expect(Identifier.timestamp(legacy)).toBe(Number(now / 0x1000n))
  })
})
