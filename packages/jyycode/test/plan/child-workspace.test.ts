import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { describe, expect, it } from "bun:test"
import { ChildWorkspace, ChildWorkspaceError, type WorktreeAdapter } from "../../src/plan/child-workspace"

function tempDirectory(prefix: string) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix))
}

describe("ChildWorkspace", () => {
  it("chooses isolated capabilities and reserves deterministically", () => {
    const root = tempDirectory("jyycode-child-project-")
    const runtime = tempDirectory("jyycode-child-runtime-")
    const manager = new ChildWorkspace({ project: { root, vcs: "none" }, runtimeRoot: runtime })
    const first = manager.reserve("ses_root", "s1_t1")
    const second = manager.reserve("ses_root", "s1_t1")
    expect(manager.capability()).toBe("snapshot")
    expect(first).toEqual(second)
    expect(first.directory).toStartWith(runtime)
    expect(first.name).toContain("s1_t1")
    expect(new ChildWorkspace({ project: { root, vcs: "none", sharedCompat: true }, runtimeRoot: runtime }).capability()).toBe(
      "shared_compat",
    )
  })

  it("creates a detached Git workspace through the Worktree adapter and reuses it", async () => {
    const root = tempDirectory("jyycode-child-git-")
    const runtime = tempDirectory("jyycode-child-runtime-")
    const calls: { info?: { name: string; directory: string; detached?: boolean }; created: number; removed: number } = {
      created: 0,
      removed: 0,
    }
    const adapter: WorktreeAdapter = {
      async makeWorktreeInfo(input) {
        const directory = path.join(runtime, input.name)
        calls.info = { ...input, directory }
        return { name: input.name, directory }
      },
      async createFromInfo(info) {
        calls.created++
        fs.mkdirSync(info.directory, { recursive: true })
        fs.writeFileSync(path.join(info.directory, "README.md"), "base")
      },
      async remove(directory) {
        calls.removed++
        fs.rmSync(directory, { recursive: true, force: true })
        return true
      },
    }
    const manager = new ChildWorkspace({ project: { root, vcs: "git" }, runtimeRoot: runtime, worktree: adapter })
    const reservation = manager.reserve("ses_root", "s1_t1")
    const first = await manager.create(reservation)
    const second = await manager.create(reservation)
    expect(calls.info).toMatchObject({ name: reservation.name, detached: true })
    expect(calls.created).toBe(1)
    expect(first.directory).toBe(second.directory)
    expect(first.baseline_manifest).toEqual([{ relative_path: "README.md", hash: expect.any(String), mode: "file" }])
    await manager.remove(first.directory)
    expect(calls.removed).toBe(1)
  })

  it("snapshots non-Git projects and produces scoped baseline-relative changes", async () => {
    const root = tempDirectory("jyycode-child-project-")
    const runtime = tempDirectory("jyycode-child-runtime-")
    fs.mkdirSync(path.join(root, "src"))
    fs.writeFileSync(path.join(root, "src", "old.ts"), "old")
    const manager = new ChildWorkspace({ project: { root, vcs: "none" }, runtimeRoot: runtime })
    const snapshot = await manager.snapshot("ses_root", "s1_t1")
    fs.writeFileSync(path.join(snapshot.directory, "src", "old.ts"), "new")
    fs.writeFileSync(path.join(snapshot.directory, "src", "new.ts"), "new")
    const changes = manager.diff(snapshot, "src")
    expect(changes).toEqual([
      { relative_path: path.join("src", "new.ts"), kind: "added", source_hash: expect.any(String), baseline_hash: null },
      { relative_path: path.join("src", "old.ts"), kind: "modified", source_hash: expect.any(String), baseline_hash: expect.any(String) },
    ])
    const metadata = manager.get("ses_root", "s1_t1")
    expect(metadata && "baseline_manifest" in metadata ? metadata.baseline_manifest : undefined).toHaveLength(1)
  })

  it("retains metadata when cleanup fails and refuses unknown directories", async () => {
    const root = tempDirectory("jyycode-child-git-")
    const runtime = tempDirectory("jyycode-child-runtime-")
    const directory = path.join(runtime, "created")
    const adapter: WorktreeAdapter = {
      async makeWorktreeInfo() {
        return { name: "created", directory }
      },
      async createFromInfo() {
        fs.mkdirSync(directory, { recursive: true })
      },
      async remove() {
        throw new Error("remove busy")
      },
    }
    const manager = new ChildWorkspace({ project: { root, vcs: "git" }, runtimeRoot: runtime, worktree: adapter })
    const reservation = manager.reserve("ses_root", "s1_t1")
    const created = await manager.create(reservation)
    await expect(manager.remove(created.directory)).rejects.toBeInstanceOf(ChildWorkspaceError)
    expect(manager.get("ses_root", "s1_t1")).toMatchObject({ directory: created.directory })
    await expect(manager.remove(path.join(runtime, "unknown"))).rejects.toMatchObject({ recoverable: false })
  })
})
