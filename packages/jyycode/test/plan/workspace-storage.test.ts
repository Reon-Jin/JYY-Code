import fs from "node:fs"
import path from "node:path"
import { describe, expect, it, spyOn } from "bun:test"
import { tmpdir } from "../fixture/fixture"
import { ChildWorkspace } from "../../src/plan/child-workspace"
import { WorkspaceLeaseStore } from "../../src/plan/workspace-lease"
import { snapshotProjectKey, snapshotRuntimeRoot } from "../../src/plan/workspace-storage"

describe("project snapshot storage", () => {
  it("keeps explicit shared compatibility handles loadable outside runtime storage", async () => {
    await using project = await tmpdir()
    await using data = await tmpdir()
    const manager = new ChildWorkspace({
      project: { root: project.path, vcs: "none", sharedCompat: true },
      runtimeRoot: data.path,
    })
    const reservation = manager.reserve("ses_shared", "s1_t1")
    expect(manager.load(reservation)?.directory).toBe(project.path)
  })
  it("isolates project directories and normalizes aliases of the same directory", async () => {
    await using first = await tmpdir()
    await using second = await tmpdir()
    await using data = await tmpdir()
    expect(snapshotRuntimeRoot(data.path, first.path)).not.toBe(snapshotRuntimeRoot(data.path, second.path))
    expect(snapshotProjectKey(first.path)).toBe(snapshotProjectKey(path.join(first.path, ".")))
    const alias = path.join(data.path, "alias")
    fs.symlinkSync(first.path, alias, process.platform === "win32" ? "junction" : "dir")
    expect(snapshotProjectKey(alias)).toBe(snapshotProjectKey(first.path))
    if (process.platform === "win32")
      expect(snapshotProjectKey(first.path.toUpperCase())).toBe(snapshotProjectKey(first.path))
  })

  it("never inventories another project's global history during an empty project preflight", async () => {
    await using project = await tmpdir()
    await using data = await tmpdir()
    const legacy = path.join(data.path, "plan-workspaces", "global")
    fs.mkdirSync(legacy, { recursive: true })
    fs.writeFileSync(path.join(legacy, "old-history.bin"), Buffer.alloc(8192))
    const manager = new ChildWorkspace({
      project: { root: project.path, vcs: "none" },
      runtimeRoot: snapshotRuntimeRoot(data.path, project.path),
      legacyRuntimeRoots: [legacy],
      workspaceBudget: { hardLimitBytes: 4096 },
    })
    const reservation = manager.reserve("ses_empty", "s1_t1")
    const readdir = spyOn(fs.promises, "readdir")
    try {
      const result = await manager.preflight([reservation])
      expect(result?.manifest.file_count).toBe(0)
      expect(result?.budget?.currentBytes).toBeLessThan(4096)
      expect(readdir.mock.calls.some(([root]) => String(root) === legacy)).toBe(false)
      expect(reservation.directory).toStartWith(snapshotRuntimeRoot(data.path, project.path))
    } finally {
      readdir.mockRestore()
    }
  })

  it("loads and cleans recorded legacy workspaces while reserving new work in the project root", async () => {
    await using project = await tmpdir()
    await using data = await tmpdir()
    fs.writeFileSync(path.join(project.path, "source.txt"), "source")
    const legacy = path.join(data.path, "global")
    const previous = new ChildWorkspace({ project: { root: project.path, vcs: "none" }, runtimeRoot: legacy })
    const old = await previous.snapshot("ses_old", "s1_t1")
    const runtimeRoot = snapshotRuntimeRoot(data.path, project.path)
    const current = new ChildWorkspace({
      project: { root: project.path, vcs: "none" },
      runtimeRoot,
      legacyRuntimeRoots: [legacy],
    })
    expect(current.reserve("ses_new", "s1_t1").directory).toStartWith(runtimeRoot)
    expect(current.load(old)?.directory).toBe(old.directory)
    const leases = new WorkspaceLeaseStore({ runtimeRoot, legacyRuntimeRoots: [legacy] })
    leases.create({
      workspace_directory: old.directory,
      root_session_id: "ses_old",
      task_id: "s1_t1",
      run_id: "old",
      session_id: "ses_child",
    })
    expect(leases.heartbeat(old.directory)?.session_id).toBe("ses_child")
    expect(await current.remove(old.directory)).toBe(true)
    expect(fs.existsSync(old.directory)).toBe(false)
    expect(fs.existsSync(leases.path(old.directory))).toBe(false)
  })
})
