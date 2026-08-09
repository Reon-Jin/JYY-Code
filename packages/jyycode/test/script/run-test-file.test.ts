import { describe, expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { runTestFile } from "../../script/run-test-file"

describe("run-test-file watchdog", () => {
  test("runs one test file and returns its exit code", async () => {
    const result = await runTestFile("test/cli/debug-storage-audit.test.ts", { cwd: process.cwd(), deadlineMs: 30_000 })
    expect(result.timedOut).toBe(false)
    expect(result.exitCode).toBe(0)
    expect(result.termination).toBeUndefined()
  }, 40_000)

  test("reports a timeout as failure and verifies the process tree", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "jyycode-watchdog-"))
    const file = path.join(root, "hang.test.ts")
    await Bun.write(file, "import { test } from 'bun:test'; test('hang', async () => await new Promise(() => {}))\n")
    try {
      const result = await runTestFile(file, { cwd: root, deadlineMs: 100 })
      expect(result.timedOut).toBe(true)
      expect(result.exitCode).not.toBe(0)
      expect(result.termination?.state).not.toBe("kill_failed")
      expect(result.termination?.remainingPids ?? []).toEqual([])
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  }, 15_000)
})
