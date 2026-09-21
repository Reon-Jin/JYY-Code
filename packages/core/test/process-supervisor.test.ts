import { describe, expect, test } from "bun:test"
import {
  createProcessInspector,
  assertProcessTreeStopped,
  isProcessAlive,
  terminateProcessTree,
} from "../src/process-supervisor"

describe("process supervisor", () => {
  test("does not interpret an unavailable process inspector as an empty tree", async () => {
    const script = `
      const { listProcessTreePids } = await import(${JSON.stringify(new URL("../src/process-supervisor.ts", import.meta.url).href)});
      try {
        await listProcessTreePids(process.pid, "linux");
        process.exit(2);
      } catch (error) {
        console.log(error.message);
      }
    `
    const child = Bun.spawn([process.execPath, "--eval", script], {
      env: { ...process.env, PATH: "__jyycode_missing_process_inspector__" },
      stdout: "pipe",
      stderr: "pipe",
    })
    const [stdout, stderr, code] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ])
    expect({ code, stderr }).toEqual({ code: 0, stderr: "" })
    expect(stdout).toContain("Unable to inspect process tree")
  })

  test("coalesces concurrent OS inspections without caching completed snapshots", async () => {
    let calls = 0
    const read = createProcessInspector(async () => {
      calls++
      await Promise.resolve()
      return [{ pid: process.pid, ppid: 1 }]
    })
    const trees = await Promise.all(Array.from({ length: 20 }, () => read("win32")))
    expect(trees.every((tree) => tree[0]?.pid === process.pid)).toBe(true)
    expect(calls).toBe(1)
    await read("win32")
    expect(calls).toBe(2)
  })
  test("a failed inspection does not poison subsequent cancellation attempts", async () => {
    let calls = 0
    const read = createProcessInspector(async () => {
      if (++calls === 1) throw new Error("inspection failed")
      return []
    })
    await expect(read("win32")).rejects.toThrow("inspection failed")
    await expect(read("win32")).resolves.toEqual([])
    expect(calls).toBe(2)
  })

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
