import { describe, expect, test } from "bun:test"
import { isTruncatedToolCall } from "../../../src/session/llm/tool-call"

describe("session.llm.isTruncatedToolCall", () => {
  test("detects an unterminated string", () => {
    expect(isTruncatedToolCall('{"path": "a", "content": "abc', new Error("Unexpected end of JSON input"))).toBe(true)
  })

  test("detects a missing closing brace", () => {
    expect(isTruncatedToolCall('{"path": "a", "content": "abc"', new Error("Unexpected end of JSON input"))).toBe(true)
  })

  test("detects an unclosed nested array", () => {
    expect(isTruncatedToolCall('{"edits": [{"old": "x", "new": "y"}', new Error("Unexpected end of JSON input"))).toBe(
      true,
    )
  })

  test("detects an escaped quote at the truncation boundary", () => {
    expect(isTruncatedToolCall('{"content": "line \\', new Error("Unterminated string in JSON at position 15"))).toBe(
      true,
    )
  })

  test("treats balanced but malformed JSON as invalid, not truncated", () => {
    expect(isTruncatedToolCall('{"path": }', new Error("Unexpected token '}'"))).toBe(false)
    expect(
      isTruncatedToolCall('{"path":"a"} trailing', new Error("Unexpected non-whitespace character after JSON")),
    ).toBe(false)
    expect(isTruncatedToolCall('{"path":"a","content":"abc"}}', new Error("Unexpected token '}'"))).toBe(false)
  })

  test("uses the parser error message as a secondary signal", () => {
    expect(isTruncatedToolCall('{"a":1}', new Error("Unexpected end of JSON input"))).toBe(true)
  })

  test("does not treat empty or undefined input as truncated", () => {
    expect(isTruncatedToolCall(undefined, new Error("Unexpected token"))).toBe(false)
    expect(isTruncatedToolCall("", new Error("Unexpected token"))).toBe(false)
  })
})
