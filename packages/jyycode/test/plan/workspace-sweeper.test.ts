import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { describe, expect, it } from "bun:test"
import { WorkspaceLeaseStore } from "../../src/plan/workspace-lease"
import { WorkspaceSweeper } from "../../src/plan/workspace-sweeper"

function tempDirectory(prefix: string) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix))
}

function setup(now: number) {
  const runtimeRoot = tempDirectory("jyycode-sweeper-")
  const workspace = path.join(runtimeRoot, "jyycode-ses_main-s1_t1-0123456789ab")
  fs.mkdirSync(workspace)
  fs.writeFileSync(
    path.join(runtimeRoot, `${path.basename(workspace)}.manifest.json`),
    JSON.stringify({
      version: 1,
      root_session_id: "ses_main",
      task_id: "s1_t1",
      name: path.basename(workspace),
      entries: [],
    }),
  )
  const store = new WorkspaceLeaseStore({ runtimeRoot, now: () => now, ttlMs: 10 })
  store.create({
    workspace_directory: workspace,
    root_session_id: "ses_main",
    task_id: "s1_t1",
    run_id: "run__ses_main__s1_t1",
    session_id: "ses_child",
  })
  return { runtimeRoot, workspace, store }
}

describe("workspace sweeper", () => {
  it("keeps active leases and reclaims an expired idle task", async () => {
    const now = 1_000
    const active = setup(now)
    const activeResult = await new WorkspaceSweeper({
      runtimeRoot: active.runtimeRoot,
      now: () => now + 20,
      sessionState: () => "active",
      planState: () => "active",
    }).scan()
    expect(activeResult.removed).toEqual([])
    expect(fs.existsSync(active.workspace)).toBe(true)

    const stale = setup(now)
    const staleResult = await new WorkspaceSweeper({
      runtimeRoot: stale.runtimeRoot,
      now: () => now + 20,
      sessionState: () => "idle",
      planState: () => "terminal",
    }).scan()
    expect(staleResult.removed).toEqual([stale.workspace])
    expect(fs.existsSync(stale.workspace)).toBe(false)
  })

  it("quarantines an unknown orphan only after the grace period", async () => {
    const now = 1_000
    const value = setup(now)
    const result = await new WorkspaceSweeper({
      runtimeRoot: value.runtimeRoot,
      now: () => now + 20,
      orphanGraceMs: 10,
      sessionState: () => "unknown",
      planState: () => "unknown",
    }).scan()
    expect(result.quarantined).toEqual([value.workspace])
    expect(fs.existsSync(value.workspace)).toBe(false)
    expect(fs.readdirSync(path.join(value.runtimeRoot, ".quarantine")).length).toBe(1)
  })

  it("persists cleanup_failed and retries it after a process restart", async () => {
    const now = 1_000
    const value = setup(now)
    let failures = 0
    const first = new WorkspaceSweeper({
      runtimeRoot: value.runtimeRoot,
      now: () => now + 20,
      sessionState: () => "idle",
      planState: () => "terminal",
      remove: async () => {
        failures++
        throw new Error("locked")
      },
    })
    const failed = await first.scan()
    expect(failed.failures.length).toBe(1)
    expect(
      JSON.parse(fs.readFileSync(path.join(value.runtimeRoot, ".jyycode-cleanup-queue.json"), "utf8")),
    ).toMatchObject({
      ["ses_main\u0000s1_t1\u0000" + path.resolve(value.workspace)]: { state: "failed", attempts: 1 },
    })
    const restarted = new WorkspaceSweeper({
      runtimeRoot: value.runtimeRoot,
      now: () => now + 2_000,
      sessionState: () => "idle",
      planState: () => "terminal",
      remove: async (candidate) => {
        await fs.promises.rm(candidate.workspaceDirectory, { recursive: true, force: true })
        await fs.promises.rm(candidate.manifestPath, { force: true })
        await fs.promises.rm(candidate.leasePath, { force: true })
      },
    })
    const recovered = await restarted.scan()
    expect(failures).toBe(1)
    expect(recovered.removed).toEqual([value.workspace])
  })

  it("coalesces re-entry into one active scan", async () => {
    const value = setup(1_000)
    let release!: () => void
    const blocked = new Promise<void>((resolve) => {
      release = resolve
    })
    const sweeper = new WorkspaceSweeper({
      runtimeRoot: value.runtimeRoot,
      now: () => 2_000,
      sessionState: () => "idle",
      planState: () => "terminal",
      remove: async () => blocked,
    })
    const first = sweeper.scan()
    const second = sweeper.scan()
    expect(first).toBe(second)
    release()
    await first
  })
})
