import { describe, expect, test } from "bun:test"
import { MCPStderrPolicy, sanitizeStderr } from "@/mcp/stderr-policy"

describe("MCP stderr policy", () => {
  test("redacts credentials and local profile paths", () => {
    const value = sanitizeStderr(
      "Authorization: Bearer secret-token x-api-key=abc123 Cookie: sid=private C:\\Users\\alice\\repo",
      "C:\\Users\\alice",
    )
    expect(value).not.toContain("secret-token")
    expect(value).not.toContain("abc123")
    expect(value).not.toContain("sid=private")
    expect(value).not.toContain("C:\\Users\\alice")
  })

  test("caps each chunk and each rolling window without retaining raw stderr", () => {
    let now = 0
    const policy = new MCPStderrPolicy({ now: () => now, maxBytesPerWindow: 10, maxChunkBytes: 4, windowMs: 100 })
    const first = policy.push("authorization: Bearer secret")
    const second = policy.push("0123456789")
    expect(first.acceptedBytes).toBe(4)
    expect(first.droppedBytes).toBe(Buffer.byteLength("authorization: Bearer secret") - 4)
    expect(second.acceptedBytes).toBe(4)
    expect(second.windowBytes).toBe(8)
    expect(second).not.toHaveProperty("sample")

    const third = policy.push("abcdefghij")
    expect(third.acceptedBytes).toBe(2)
    expect(third.droppedBytes).toBe(8)
    now = 100
    expect(policy.push("reset").acceptedBytes).toBe(4)
  })
})
