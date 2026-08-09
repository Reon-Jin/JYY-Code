import { describe, expect, test } from "bun:test"
import { assertProcessTreeStopped, isProcessAlive, terminateProcessTree } from "../src/process-supervisor"

describe("process supervisor", () => {
  test("does not report a missing process as a successful kill", async () => {
    const pid = 2_147_483_000
    expect(isProcessAlive(pid)).toBe(false)
    await expect(terminateProcessTree(pid, { verifyMs: 5, graceMs: 5 })).resolves.toEqual({
      state: "exited",
      pid,
      remainingPids: [],
    })
  })

  test("assertProcessTreeStopped is idempotent for an already exited PID", async () => {
    const pid = 2_147_482_999
    await expect(assertProcessTreeStopped(pid, { verifyMs: 5, graceMs: 5 })).resolves.toEqual({
      state: "exited",
      pid,
      remainingPids: [],
    })
  })

  test("recognizes the current process as alive without terminating it", () => {
    expect(isProcessAlive(process.pid)).toBe(true)
  })
})
