import { expect, test } from "bun:test"
import { runSessionStorageSoak } from "../../script/session-storage-soak"

test("session storage soak stays bounded and leaves no child processes", async () => {
  const report = await Promise.race([
    runSessionStorageSoak({ sessions: 12, children: 24, blobBytes: 64 * 1024 * 1024, events: 5_000, watchdogMs: 10_000 }),
    new Promise<never>((_, reject) => setTimeout(() => reject(new Error("session storage soak test watchdog expired")), 15_000)),
  ])
  expect(report.verifiedZeroChildProcesses).toBe(true)
  expect(report.deduplicatedBlobs).toBe(1)
  expect(report.physicalBlobBytes).toBeLessThan(report.logicalBlobBytes)
  expect(report.eventQueueBound).toBeLessThanOrEqual(256)
  expect(report.mcpStarts).toBe(1)
  expect(report.mcpCloses).toBe(1)
  expect(report.mcpRemaining).toBe(0)
  expect(report.lspOpenDocumentBound).toBeLessThanOrEqual(50)
})
