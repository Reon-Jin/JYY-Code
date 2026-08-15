import { expect, test } from "bun:test"
import { createOutputRetention } from "@jyycode-ai/core/output-retention"

test("keeps preview memory bounded for a 100MB synthetic process stream", async () => {
  Bun.gc?.(true)
  const before = process.memoryUsage().heapUsed
  const retention = createOutputRetention({ maxBytes: 64 * 1024, strategy: "head_tail" })
  const chunk = new Uint8Array(1024 * 1024).fill(65)

  for (let index = 0; index < 100; index++) await retention.append(chunk)
  const result = await retention.flush()

  Bun.gc?.(true)
  const heapGrowth = process.memoryUsage().heapUsed - before
  expect(result.bytesSeen).toBe(100 * 1024 * 1024)
  expect(result.bytesRetained).toBe(64 * 1024)
  expect(result.truncated).toBe(true)
  expect(heapGrowth).toBeLessThan(32 * 1024 * 1024)
})
