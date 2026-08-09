import { describe, expect, test } from "bun:test"
import { MCPServerManager, canonicalMCPLeaseKey } from "@/mcp/manager"

describe("MCP server manager", () => {
  test("deduplicates identical starts and releases after the idle TTL", async () => {
    let now = 0
    let starts = 0
    let closes = 0
    const manager = new MCPServerManager<number>({ now: () => now, idleTtlMs: 100 })
    const key = { worktree: ".", server: "one", command: "node", args: ["server.js"], config: { mode: "safe" } }

    const first = await manager.acquire(key, async () => ++starts, async () => void closes++)
    const second = await manager.acquire(key, async () => ++starts, async () => void closes++)
    expect(first.value).toBe(1)
    expect(second.value).toBe(1)
    expect(starts).toBe(1)

    await first.release()
    now = 50
    expect((await manager.sweep()).closed).toBe(0)
    await second.release()
    now = 151
    expect((await manager.sweep()).closed).toBe(1)
    expect(closes).toBe(1)
  })

  test("bounds concurrent starts and differentiates security/worktree keys", async () => {
    let active = 0
    let peak = 0
    const manager = new MCPServerManager<number>({ maxConcurrency: 2 })
    const start = async () => {
      active++
      peak = Math.max(peak, active)
      await new Promise((resolve) => setTimeout(resolve, 5))
      active--
      return peak
    }
    await Promise.all([
      manager.acquire("a", start, async () => {}),
      manager.acquire("b", start, async () => {}),
      manager.acquire("c", start, async () => {}),
      manager.acquire("d", start, async () => {}),
    ])
    expect(peak).toBe(2)

    const one = canonicalMCPLeaseKey({ worktree: "C:/repo", command: "node", args: ["a"], securityScope: "read" })
    const two = canonicalMCPLeaseKey({ worktree: "C:/repo", command: "node", args: ["a"], securityScope: "write" })
    const three = canonicalMCPLeaseKey({ worktree: "C:/other", command: "node", args: ["a"], securityScope: "read" })
    expect(one).not.toBe(two)
    expect(one).not.toBe(three)
  })

  test("retains failed closes as degraded entries for a later sweep", async () => {
    let now = 0
    let attempts = 0
    const manager = new MCPServerManager<number>({ now: () => now, idleTtlMs: 10 })
    const lease = await manager.acquire("degraded", async () => 1, async () => {
      attempts++
      if (attempts === 1) throw new Error("busy")
    })
    await lease.release()
    now = 10
    expect((await manager.sweep()).degraded).toBe(1)
    expect(manager.degradedSize()).toBe(1)
    now = 20
    expect((await manager.sweep()).closed).toBe(1)
    expect(manager.degradedSize()).toBe(0)
  })
})
