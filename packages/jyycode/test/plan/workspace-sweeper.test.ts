import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { afterEach, describe, expect, it } from "bun:test"
import { WorkspaceLeaseStore } from "../../src/plan/workspace-lease"
import { WorkspaceSweeper, purgeExpiredWorkspaceQuarantine } from "../../src/plan/workspace-sweeper"

const temporaryDirectories: string[] = []

function tempDirectory(prefix: string) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), prefix))
  temporaryDirectories.push(directory)
  return directory
}

afterEach(async () => {
  for (const directory of temporaryDirectories.splice(0))
    await fs.promises.rm(directory, { recursive: true, force: true, maxRetries: 3 })
})

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
  it("preserves unknown workspaces and existing quarantine without explicit reclamation", async () => {
    const value = setup(1_000)
    const quarantine = path.join(value.runtimeRoot, ".quarantine", "unreviewed")
    fs.mkdirSync(quarantine, { recursive: true })
    fs.writeFileSync(path.join(quarantine, "keep.txt"), "unmerged work")
    fs.utimesSync(quarantine, new Date(0), new Date(0))
    const result = await new WorkspaceSweeper({ runtimeRoot: value.runtimeRoot, now: () => Date.now() }).scan()
    expect(result.preserved).toContain(value.workspace)
    expect(fs.existsSync(value.workspace)).toBe(true)
    expect(fs.readFileSync(path.join(quarantine, "keep.txt"), "utf8")).toBe("unmerged work")
  })

  it("preserves newly quarantined workspaces even when their contents are old", async () => {
    const now = Date.now()
    const value = setup(now - 10 * 24 * 60 * 60_000)
    fs.utimesSync(value.workspace, new Date(0), new Date(0))
    const result = await new WorkspaceSweeper({
      runtimeRoot: value.runtimeRoot,
      now: () => now,
      allowOrphanQuarantine: true,
    }).scan()
    expect(result.quarantined).toEqual([value.workspace])
    const entries = fs.readdirSync(path.join(value.runtimeRoot, ".quarantine"))
    expect(entries).toHaveLength(1)
  })

  it("refuses a quarantine root redirected outside the runtime root", async () => {
    const value = setup(1_000)
    const outside = tempDirectory("jyycode-sweeper-outside-")
    const protectedFile = path.join(outside, "keep.txt")
    fs.writeFileSync(protectedFile, "keep")
    fs.utimesSync(protectedFile, new Date(0), new Date(0))
    fs.symlinkSync(
      outside,
      path.join(value.runtimeRoot, ".quarantine"),
      process.platform === "win32" ? "junction" : "dir",
    )
    await expect(
      purgeExpiredWorkspaceQuarantine({ runtimeRoot: value.runtimeRoot, now: Date.now() }),
    ).rejects.toMatchObject({ code: "OUTSIDE_RUNTIME_ROOT" })
    expect(fs.readFileSync(protectedFile, "utf8")).toBe("keep")
  })

  it("removes legacy baseline directories together with an expired workspace", async () => {
    const value = setup(1_000)
    const baseline = `${value.workspace}.baseline`
    fs.mkdirSync(baseline)
    fs.writeFileSync(path.join(baseline, "data.txt"), "base")
    const result = await new WorkspaceSweeper({
      runtimeRoot: value.runtimeRoot,
      now: () => 2_000,
      sessionState: () => "idle",
      planState: () => "terminal",
    }).scan()
    expect(result.failures).toEqual([])
    expect(result.removed).toEqual([value.workspace])
    expect(fs.existsSync(baseline)).toBe(false)
  })

  it("eventually visits later candidates behind a preserved lease", async () => {
    const value = setup(1_000)
    const later = path.join(value.runtimeRoot, "later")
    fs.mkdirSync(later)
    fs.writeFileSync(
      path.join(value.runtimeRoot, "later.manifest.json"),
      JSON.stringify({
        version: 1,
        root_session_id: "ses_main",
        task_id: "s1_t2",
        name: "later",
        entries: [],
      }),
    )
    value.store.create({
      workspace_directory: later,
      root_session_id: "ses_main",
      task_id: "s1_t2",
      run_id: "run__ses_main__s1_t2",
      session_id: "ses_later",
      now: 1_001,
    })
    const sweeper = new WorkspaceSweeper({
      runtimeRoot: value.runtimeRoot,
      now: () => 2_000,
      maxItemsPerScan: 1,
      sessionState: (lease) => (lease.task_id === "s1_t1" ? "active" : "idle"),
      planState: () => "terminal",
    })
    expect((await sweeper.scan()).preserved).toEqual([value.workspace])
    expect((await sweeper.scan()).removed).toEqual([later])
    expect(fs.existsSync(value.workspace)).toBe(true)
  })

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
      allowOrphanQuarantine: true,
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
