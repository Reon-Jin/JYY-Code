import { expect, test } from "bun:test"
import {
  DEFAULT_MCP_IDLE_TIMEOUT,
  DEFAULT_MCP_TOTAL_TIMEOUT,
  MAX_MCP_IDLE_TIMEOUT,
  MAX_MCP_TOTAL_TIMEOUT,
  mcpRequestOptions,
  resolveMcpTimeouts,
  withMcpRequest,
} from "../../src/mcp/index"

test("MCP timeout migration keeps timeout as the idle alias and enforces caps", () => {
  expect(resolveMcpTimeouts()).toEqual({
    idleMs: DEFAULT_MCP_IDLE_TIMEOUT,
    totalMs: DEFAULT_MCP_TOTAL_TIMEOUT,
  })
  expect(resolveMcpTimeouts({ timeout: 10_000 })).toEqual({ idleMs: 10_000, totalMs: DEFAULT_MCP_TOTAL_TIMEOUT })
  expect(resolveMcpTimeouts({ idle_timeout_ms: 999_999, total_timeout_ms: 999_999 })).toEqual({
    idleMs: MAX_MCP_IDLE_TIMEOUT,
    totalMs: MAX_MCP_TOTAL_TIMEOUT,
  })
  expect(() => resolveMcpTimeouts({ idle_timeout_ms: 90_000, total_timeout_ms: 10_000 })).toThrow(
    "greater than or equal",
  )
})

test("MCP SDK options reset idle timeout on progress but retain an absolute total timeout", () => {
  const controller = new AbortController()
  const onprogress = () => undefined
  expect(mcpRequestOptions({ idleMs: 60_000, totalMs: 300_000 }, controller.signal, onprogress)).toMatchObject({
    timeout: 60_000,
    maxTotalTimeout: 300_000,
    resetTimeoutOnProgress: true,
    signal: controller.signal,
    onprogress,
  })
})

test("MCP total deadline aborts a silent request and releases its transport/request", async () => {
  let requestReleased = false
  let transportReleased = false

  await expect(
    withMcpRequest(
      (signal) =>
        new Promise<never>((_resolve, reject) => {
          signal.addEventListener(
            "abort",
            () => {
              requestReleased = true
              transportReleased = true
              reject(signal.reason)
            },
            { once: true },
          )
        }),
      { idleMs: 10, totalMs: 30 },
      "silent MCP request",
    ),
  ).rejects.toThrow("timed out")

  expect(requestReleased).toBe(true)
  expect(transportReleased).toBe(true)
})
