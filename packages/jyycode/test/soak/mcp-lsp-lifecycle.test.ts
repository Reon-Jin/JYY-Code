import { expect, test } from "bun:test"
import { DocumentCache } from "../../src/lsp/document-cache"
import { MCPServerManager } from "../../src/mcp/manager"

test("MCP and LSP lifecycle resources return to bounded baselines", async () => {
  const result = await Promise.race([
    (async () => {
      let now = 0
      let starts = 0
      let closes = 0
      const manager = new MCPServerManager<number>({ idleTtlMs: 100, maxConcurrency: 4, now: () => now })
      for (let index = 0; index < 100; index++) {
        const lease = await manager.acquire(
          { worktree: "C:/soak", server: "test", command: "synthetic", securityScope: "read" },
          async () => ++starts,
          async () => {
            closes++
          },
        )
        await lease.release()
      }
      now = 101
      const swept = await manager.sweep()

      const cache = new DocumentCache({ maxOpenDocuments: 50, maxDocumentTextBytes: 128 })
      for (let index = 0; index < 200; index++) cache.set(`file-${index}`, index, "x".repeat(1024))
      return { starts, closes, swept, mcpSize: manager.size(), lspSize: cache.size }
    })(),
    new Promise<never>((_, reject) => setTimeout(() => reject(new Error("MCP/LSP lifecycle watchdog expired")), 5_000)),
  ])

  expect(result.starts).toBe(1)
  expect(result.closes).toBe(1)
  expect(result.swept.closed).toBe(1)
  expect(result.mcpSize).toBe(0)
  expect(result.lspSize).toBe(50)
})
