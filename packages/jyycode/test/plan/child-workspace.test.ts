import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { execFileSync } from "node:child_process"
import { afterEach, describe, expect, it } from "bun:test"
import {
  ChildWorkspace,
  ChildWorkspaceError,
  __childWorkspaceCopyStats,
  __childWorkspaceGitStats,
  __childWorkspaceHashStats,
  type WorktreeAdapter,
} from "../../src/plan/child-workspace"
import { assertRuntimePath, WorkspacePathError } from "../../src/plan/workspace-path"

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
    expect(
      new ChildWorkspace({ project: { root, vcs: "none", sharedCompat: true }, runtimeRoot: runtime }).capability(),
    ).toBe("shared_compat")
  })

  it("creates a detached Git workspace through the Worktree adapter and reuses it", async () => {
    const root = tempDirectory("jyycode-child-git-")
    const runtime = tempDirectory("jyycode-child-runtime-")
    fs.writeFileSync(path.join(root, "README.md"), "parent base")
    const calls: {
      info?: { name: string; directory: string; detached?: boolean }
      created: number
      skippedBoot: number
      removed: number
    } = {
      created: 0,
      skippedBoot: 0,
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
        fs.writeFileSync(path.join(info.directory, "README.md"), "adapter base")
      },
      async createFromInfoWithoutBoot(info) {
        calls.skippedBoot++
        fs.mkdirSync(info.directory, { recursive: true })
        fs.writeFileSync(path.join(info.directory, "README.md"), "adapter base")
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
    expect(calls.created).toBe(0)
    expect(calls.skippedBoot).toBe(1)
    expect(first.directory).toBe(second.directory)
    expect(first.baseline_manifest).toEqual([
      { relative_path: "README.md", hash: expect.any(String), size: 11, mode: "file" },
    ])
    await manager.remove(first.directory)
    expect(calls.removed).toBe(1)
  })

  it("reuses one Git baseline across a dispatch batch", async () => {
    const root = tempDirectory("jyycode-child-git-batch-")
    const runtime = tempDirectory("jyycode-child-git-batch-runtime-")
    fs.writeFileSync(path.join(root, "README.md"), "parent base")
    let created = 0
    const adapter: WorktreeAdapter = {
      async makeWorktreeInfo(input) {
        return { name: input.name, directory: path.join(runtime, input.name) }
      },
      async createFromInfo(info) {
        created++
        fs.mkdirSync(path.join(info.directory, ".git"), { recursive: true })
      },
      async remove(directory) {
        fs.rmSync(directory, { recursive: true, force: true })
        return true
      },
    }
    const manager = new ChildWorkspace({ project: { root, vcs: "git" }, runtimeRoot: runtime, worktree: adapter })
    const reservations = ["s1_t1", "s1_t2"].map((taskId) => manager.reserve("ses_root", taskId))

    await manager.preflight(reservations)
    const children = await Promise.all(reservations.map((reservation) => manager.create(reservation)))

    expect(created).toBe(2)
    expect(new Set(children.map((child) => child.baseline_directory)).size).toBe(1)
    expect(children[0]?.baseline_manifest_hash).toBe(children[1]?.baseline_manifest_hash)
  })

  it("reuses the persisted Git manifest hash cache across dispatch waves", async () => {
    const root = tempDirectory("jyycode-child-git-cache-")
    const runtime = tempDirectory("jyycode-child-git-cache-runtime-")
    for (let index = 0; index < 20; index++) {
      fs.writeFileSync(path.join(root, `file-${index}.ts`), "x".repeat(64))
    }
    const manager = new ChildWorkspace({ project: { root, vcs: "git" }, runtimeRoot: runtime })

    await manager.preflight([manager.reserve("ses_root", "s1_t1")])
    __childWorkspaceHashStats.filesRead = 0
    await manager.preflight([manager.reserve("ses_root", "s1_t2")])

    expect(__childWorkspaceHashStats.filesRead).toBe(0)
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
    const changes = await manager.diff(snapshot, "src")
    expect(changes).toEqual([
      {
        relative_path: path.join("src", "new.ts"),
        kind: "added",
        source_hash: expect.any(String),
        baseline_hash: null,
      },
      {
        relative_path: path.join("src", "old.ts"),
        kind: "modified",
        source_hash: expect.any(String),
        baseline_hash: expect.any(String),
      },
    ])
    const metadata = manager.get("ses_root", "s1_t1")
    expect(metadata && "baseline_manifest" in metadata ? metadata.baseline_manifest : undefined).toHaveLength(1)
  })

  it("records a durable baseline sidecar for later merge and restart", async () => {
    const root = tempDirectory("jyycode-child-project-")
    const runtime = tempDirectory("jyycode-child-runtime-")
    fs.mkdirSync(path.join(root, "src"), { recursive: true })
    fs.writeFileSync(path.join(root, "src", "main.ts"), "export const value = 1\n")
    const manager = new ChildWorkspace({ project: { root, vcs: "none" }, runtimeRoot: runtime })
    const reservation = manager.reserve("ses_root", "s1_t1")
    const created = await manager.create(reservation)

    expect(created.baseline_directory).toStartWith(runtime)
    expect(created.baseline_directory).not.toBe(created.directory)
    expect(created.baseline_manifest_hash).toMatch(/^[a-f0-9]{64}$/)
    expect(fs.readFileSync(path.join(created.baseline_directory!, "src", "main.ts"), "utf8")).toBe(
      "export const value = 1\n",
    )

    const restarted = new ChildWorkspace({ project: { root, vcs: "none" }, runtimeRoot: runtime })
    expect(restarted.load(reservation)).toMatchObject({
      directory: created.directory,
      baseline_directory: created.baseline_directory,
      baseline_manifest_hash: created.baseline_manifest_hash,
    })
  })

  it.each([false, true])("recovers partial cleanup after restart (baseline removed: %s)", async (removeBaseline) => {
    const root = tempDirectory("jyycode-cleanup-project-")
    const runtime = tempDirectory("jyycode-cleanup-runtime-")
    fs.writeFileSync(path.join(root, "keep.txt"), "parent data")
    const options = { project: { root, vcs: "none" as const }, runtimeRoot: runtime }
    const manager = new ChildWorkspace(options)
    const created = await manager.create(manager.reserve("ses_root", "s1_t1"))
    await fs.promises.rm(created.directory, { recursive: true })
    if (removeBaseline) await fs.promises.rm(created.baseline_directory!, { recursive: true })
    const restarted = new ChildWorkspace(options)
    expect(restarted.load(created)).toBeUndefined()
    expect(() => restarted.load({ ...created, taskId: "s1_forged" }, { forCleanup: true })).toThrow()
    const recovered = restarted.load(created, { forCleanup: true })
    expect(recovered).toBeDefined()
    await restarted.remove(recovered!.directory)
    expect(fs.existsSync(created.baseline_directory!)).toBe(false)
    expect(fs.existsSync(created.baseline_manifest_path!)).toBe(false)
    expect(fs.readFileSync(path.join(root, "keep.txt"), "utf8")).toBe("parent data")
  })

  it("reuses one immutable baseline for a snapshot dispatch batch", async () => {
    const root = tempDirectory("jyycode-child-batch-project-")
    const runtime = tempDirectory("jyycode-child-batch-runtime-")
    fs.mkdirSync(path.join(root, "src"), { recursive: true })
    fs.mkdirSync(path.join(root, "node_modules"), { recursive: true })
    fs.mkdirSync(path.join(root, ".git"), { recursive: true })
    fs.mkdirSync(path.join(root, ".jyycode"), { recursive: true })
    fs.mkdirSync(path.join(root, "build"), { recursive: true })
    fs.writeFileSync(path.join(root, "src", "main.ts"), "export const main = true\n")
    fs.writeFileSync(path.join(root, "node_modules", "ignored.js"), "ignored")
    fs.writeFileSync(path.join(root, ".git", "ignored"), "ignored")
    fs.writeFileSync(path.join(root, ".jyycode", "ignored"), "ignored")
    fs.writeFileSync(path.join(root, "build", "ignored"), "ignored")
    fs.writeFileSync(path.join(root, "large.bin"), Buffer.alloc(20 * 1024 * 1024, 7))

    const manager = new ChildWorkspace({ project: { root, vcs: "none" }, runtimeRoot: runtime })
    const reservations = ["s1_t1", "s1_t2", "s1_t3"].map((taskId) => manager.reserve("ses_root", taskId))
    const preflight = await manager.preflight(reservations)
    expect(preflight?.manifest.file_count).toBe(2)
    expect(preflight?.manifest.total_bytes).toBeGreaterThan(20 * 1024 * 1024)
    const children = await Promise.all(reservations.map((reservation) => manager.create(reservation)))

    expect(new Set(children.map((child) => child.baseline_directory)).size).toBe(1)
    expect(new Set(children.map((child) => child.baseline_id)).size).toBe(1)
    expect(fs.readdirSync(runtime).filter((name) => name.endsWith(".baseline")).length).toBe(0)
    expect(fs.readdirSync(runtime).filter((name) => name.endsWith(".manifest.json")).length).toBe(3)
    expect(fs.existsSync(path.join(children[0]!.directory, "node_modules"))).toBe(false)
    expect(fs.existsSync(path.join(children[0]!.directory, ".git"))).toBe(false)
    expect(fs.existsSync(path.join(children[0]!.directory, ".jyycode"))).toBe(false)
    expect(fs.existsSync(path.join(children[0]!.directory, "build"))).toBe(false)

    await manager.remove(children[0]!.directory)
    expect(fs.existsSync(children[1]!.baseline_directory!)).toBe(true)
    await manager.remove(children[1]!.directory)
    await manager.remove(children[2]!.directory)
    expect(fs.existsSync(children[2]!.baseline_directory!)).toBe(false)
  })

  it("hardlinks unchanged files into a later baseline instead of recopying them", async () => {
    const root = tempDirectory("jyycode-child-incremental-project-")
    const runtime = tempDirectory("jyycode-child-incremental-runtime-")
    for (let index = 0; index < 10; index++) {
      fs.writeFileSync(path.join(root, `file-${index}.txt`), "x".repeat(256))
    }
    const manager = new ChildWorkspace({ project: { root, vcs: "none" }, runtimeRoot: runtime })

    __childWorkspaceCopyStats.baselineLinks = []
    __childWorkspaceCopyStats.baselineCopies = []
    const first = await manager.create(manager.reserve("ses_root", "s1_t1"))
    expect(__childWorkspaceCopyStats.baselineCopies).toHaveLength(10)
    expect(__childWorkspaceCopyStats.baselineLinks).toHaveLength(0)

    fs.writeFileSync(path.join(root, "file-0.txt"), "y".repeat(256))
    __childWorkspaceCopyStats.baselineLinks = []
    __childWorkspaceCopyStats.baselineCopies = []
    const second = await manager.create(manager.reserve("ses_root", "s2_t1"))

    expect(second.baseline_directory).not.toBe(first.baseline_directory)
    expect(__childWorkspaceCopyStats.baselineCopies).toEqual(["file-0.txt"])
    expect([...__childWorkspaceCopyStats.baselineLinks].sort()).toEqual(
      Array.from({ length: 9 }, (_, index) => `file-${index + 1}.txt`),
    )
    expect(fs.readFileSync(path.join(second.baseline_directory!, "file-9.txt"), "utf8")).toBe("x".repeat(256))
  })

  it("starts a Git child from the dirty parent snapshot while preserving worktree metadata", async () => {
    const root = tempDirectory("jyycode-child-project-")
    const runtime = tempDirectory("jyycode-child-runtime-")
    fs.writeFileSync(path.join(root, "dirty.txt"), "parent dirty\n")
    const adapter: WorktreeAdapter = {
      async makeWorktreeInfo(input) {
        return { name: input.name, directory: path.join(runtime, input.name) }
      },
      async createFromInfo(info) {
        fs.mkdirSync(info.directory, { recursive: true })
        fs.mkdirSync(path.join(info.directory, ".git"), { recursive: true })
        fs.writeFileSync(path.join(info.directory, "dirty.txt"), "HEAD\n")
      },
      async remove(directory) {
        fs.rmSync(directory, { recursive: true, force: true })
        return true
      },
    }
    const manager = new ChildWorkspace({ project: { root, vcs: "git" }, runtimeRoot: runtime, worktree: adapter })
    const created = await manager.create(manager.reserve("ses_root", "s1_t1"))
    expect(fs.readFileSync(path.join(created.directory, "dirty.txt"), "utf8")).toBe("parent dirty\n")
    expect(fs.existsSync(path.join(created.directory, ".git"))).toBe(true)
    expect(fs.readFileSync(path.join(created.baseline_directory!, "dirty.txt"), "utf8")).toBe("parent dirty\n")
  })

  it("copies only bounded source snapshots and records manifest limits", async () => {
    const root = tempDirectory("jyycode-child-filtered-project-")
    const runtime = tempDirectory("jyycode-child-filtered-runtime-")
    fs.mkdirSync(path.join(root, "src"), { recursive: true })
    fs.writeFileSync(path.join(root, ".gitignore"), "ignored.txt\n")
    fs.writeFileSync(path.join(root, "src", "tracked.ts"), "export const dirty = true\n")
    execFileSync("git", ["init", "--quiet"], { cwd: root })
    execFileSync("git", ["config", "user.email", "child-test@example.com"], { cwd: root })
    execFileSync("git", ["config", "user.name", "Child Test"], { cwd: root })
    execFileSync("git", ["add", ".gitignore", "src/tracked.ts"], { cwd: root })
    execFileSync("git", ["commit", "--quiet", "-m", "base"], { cwd: root })
    fs.writeFileSync(path.join(root, "src", "tracked.ts"), "export const dirty = changed\n")
    fs.writeFileSync(path.join(root, "src", "untracked.ts"), "export const newSource = true\n")
    fs.writeFileSync(path.join(root, "ignored.txt"), "ignored\n")
    fs.mkdirSync(path.join(root, "node_modules", "dependency"), { recursive: true })
    fs.writeFileSync(path.join(root, "node_modules", "dependency", "index.js"), "dependency\n")
    fs.mkdirSync(path.join(root, "build", "cache"), { recursive: true })
    fs.writeFileSync(path.join(root, "build", "cache", "bundle.js"), "cache\n")
    fs.mkdirSync(path.join(root, ".jyycode", "context"), { recursive: true })
    fs.mkdirSync(path.join(root, ".jyycode", "memory"), { recursive: true })
    fs.writeFileSync(path.join(root, ".jyycode", "context", "session.json"), "runtime\n")
    fs.writeFileSync(path.join(root, ".env"), "TOKEN=do-not-copy\n")

    const adapter: WorktreeAdapter = {
      async makeWorktreeInfo(input) {
        return { name: input.name, directory: path.join(runtime, input.name) }
      },
      async createFromInfo(info) {
        fs.mkdirSync(path.join(info.directory, ".git"), { recursive: true })
      },
      async remove(directory) {
        fs.rmSync(directory, { recursive: true, force: true })
        return true
      },
    }
    const manager = new ChildWorkspace({ project: { root, vcs: "git" }, runtimeRoot: runtime, worktree: adapter })
    const created = await manager.create(manager.reserve("ses_root", "s1_t1"))

    expect(fs.readFileSync(path.join(created.directory, "src", "tracked.ts"), "utf8")).toContain("dirty")
    expect(fs.existsSync(path.join(created.directory, "src", "untracked.ts"))).toBe(true)
    for (const excluded of ["node_modules", "build", ".jyycode", ".env", "ignored.txt"])
      expect(fs.existsSync(path.join(created.directory, excluded))).toBe(false)
    expect(created.baseline_manifest_path).toBeTruthy()
    expect(created.baseline_manifest_size).toBeGreaterThan(0)
    expect(created.baseline_manifest_file_count).toBe(created.baseline_manifest.length)
    expect(fs.existsSync(created.baseline_manifest_path!)).toBe(true)
  })

  it("overlays only dirty and untracked files into a Git worktree", async () => {
    const root = tempDirectory("jyycode-child-overlay-project-")
    const runtime = tempDirectory("jyycode-child-overlay-runtime-")
    fs.writeFileSync(path.join(root, "clean.ts"), "export const clean = true\n")
    fs.writeFileSync(path.join(root, "dirty.ts"), "export const value = 1\n")
    execFileSync("git", ["init", "--quiet"], { cwd: root })
    execFileSync("git", ["config", "user.email", "child-test@example.com"], { cwd: root })
    execFileSync("git", ["config", "user.name", "Child Test"], { cwd: root })
    execFileSync("git", ["add", "clean.ts", "dirty.ts"], { cwd: root })
    execFileSync("git", ["commit", "--quiet", "-m", "base"], { cwd: root })
    fs.writeFileSync(path.join(root, "dirty.ts"), "export const value = 2\n")
    fs.writeFileSync(path.join(root, "untracked.ts"), "export const fresh = true\n")

    const adapter: WorktreeAdapter = {
      async makeWorktreeInfo(input) {
        return { name: input.name, directory: path.join(runtime, input.name) }
      },
      async createFromInfo(info) {
        fs.mkdirSync(path.join(info.directory, ".git"), { recursive: true })
      },
      async remove(directory) {
        fs.rmSync(directory, { recursive: true, force: true })
        return true
      },
    }
    __childWorkspaceCopyStats.overlayPaths = []
    const manager = new ChildWorkspace({ project: { root, vcs: "git" }, runtimeRoot: runtime, worktree: adapter })
    const created = await manager.create(manager.reserve("ses_root", "s1_t1"))

    expect(__childWorkspaceCopyStats.overlayPaths).not.toContain("clean.ts")
    expect(__childWorkspaceCopyStats.overlayPaths).toContain("dirty.ts")
    expect(__childWorkspaceCopyStats.overlayPaths).toContain("untracked.ts")
    expect(fs.readFileSync(path.join(created.directory, "dirty.ts"), "utf8")).toContain("value = 2")
    expect(fs.existsSync(path.join(created.directory, "untracked.ts"))).toBe(true)
  })

  it("scans Git status once per dispatch wave instead of once per child", async () => {
    const root = tempDirectory("jyycode-child-wave-project-")
    const runtime = tempDirectory("jyycode-child-wave-runtime-")
    fs.writeFileSync(path.join(root, "clean.ts"), "export const clean = true\n")
    execFileSync("git", ["init", "--quiet"], { cwd: root })
    execFileSync("git", ["config", "user.email", "child-test@example.com"], { cwd: root })
    execFileSync("git", ["config", "user.name", "Child Test"], { cwd: root })
    execFileSync("git", ["add", "clean.ts"], { cwd: root })
    execFileSync("git", ["commit", "--quiet", "-m", "base"], { cwd: root })
    const adapter: WorktreeAdapter = {
      async makeWorktreeInfo(input) {
        return { name: input.name, directory: path.join(runtime, input.name) }
      },
      async createFromInfo(info) {
        fs.mkdirSync(path.join(info.directory, ".git"), { recursive: true })
      },
      async remove(directory) {
        fs.rmSync(directory, { recursive: true, force: true })
        return true
      },
    }
    const manager = new ChildWorkspace({ project: { root, vcs: "git" }, runtimeRoot: runtime, worktree: adapter })
    const reservations = ["s1_t1", "s1_t2"].map((taskId) => manager.reserve("ses_root", taskId))

    __childWorkspaceGitStats.dirtyScans = 0
    await manager.preflight(reservations)
    await Promise.all(reservations.map((reservation) => manager.create(reservation)))

    expect(__childWorkspaceGitStats.dirtyScans).toBe(1)
  })

  it("applies the same ignore policy to non-Git snapshots and reports size limits", async () => {
    const root = tempDirectory("jyycode-child-non-git-filtered-")
    const runtime = tempDirectory("jyycode-child-non-git-runtime-")
    fs.writeFileSync(path.join(root, ".gitignore"), "ignored.txt\n")
    fs.writeFileSync(path.join(root, "source.ts"), "source\n")
    fs.writeFileSync(path.join(root, "ignored.txt"), "ignored\n")
    const manager = new ChildWorkspace({
      project: { root, vcs: "none" },
      runtimeRoot: runtime,
      snapshotLimits: { maxFileBytes: 4, maxTotalBytes: 100, maxFileCount: 10 },
    })
    await expect(manager.snapshot("ses_root", "s1_t1")).rejects.toThrow("per-file limit")

    const retryRoot = tempDirectory("jyycode-child-non-git-retry-")
    fs.writeFileSync(path.join(retryRoot, ".gitignore"), "ignored.txt\n")
    fs.writeFileSync(path.join(retryRoot, "source.ts"), "ok\n")
    fs.writeFileSync(path.join(retryRoot, "ignored.txt"), "ignored\n")
    const retry = new ChildWorkspace({
      project: { root: retryRoot, vcs: "none" },
      runtimeRoot: tempDirectory("jyycode-child-non-git-retry-runtime-"),
    })
    const created = await retry.snapshot("ses_root", "s1_t1")
    expect(fs.existsSync(path.join(created.directory, "source.ts"))).toBe(true)
    expect(fs.existsSync(path.join(created.directory, "ignored.txt"))).toBe(false)
  })

  it("preserves binary and symlink baseline entries and rejects unsafe baseline paths", async () => {
    const root = tempDirectory("jyycode-child-project-")
    const runtime = tempDirectory("jyycode-child-runtime-")
    fs.writeFileSync(path.join(root, "data.bin"), new Uint8Array([0, 1, 255, 2]))
    let hasSymlink = true
    try {
      fs.symlinkSync("data.bin", path.join(root, "data.link"), "file")
    } catch {
      hasSymlink = false
    }
    const manager = new ChildWorkspace({ project: { root, vcs: "none" }, runtimeRoot: runtime })
    const created = await manager.create(manager.reserve("ses_root", "s1_t1"))
    expect(created.baseline_manifest.some((entry) => entry.relative_path === "data.bin" && entry.mode === "file")).toBe(
      true,
    )
    if (hasSymlink)
      expect(
        created.baseline_manifest.some((entry) => entry.relative_path === "data.link" && entry.mode === "symlink"),
      ).toBe(true)

    const unsafe = manager.reserve("ses_root", "s1_t2")
    await expect(
      manager.create({ ...unsafe, baseline_directory: path.join(runtime, "..", "outside-baseline") }),
    ).rejects.toBeInstanceOf(ChildWorkspaceError)
  })

  it("does not create or remove baseline state for shared compatibility", async () => {
    const root = tempDirectory("jyycode-child-project-")
    const runtime = tempDirectory("jyycode-child-runtime-")
    fs.writeFileSync(path.join(root, "README.md"), "shared\n")
    const manager = new ChildWorkspace({ project: { root, vcs: "none", sharedCompat: true }, runtimeRoot: runtime })
    const created = await manager.create(manager.reserve("ses_root", "s1_t1"))
    expect(created.baseline_directory).toBeNull()
    expect(created.baseline_manifest_hash).toBeNull()
    expect(fs.readdirSync(runtime)).toEqual([])
    await expect(manager.remove(root)).rejects.toMatchObject({ recoverable: false })
  })

  it.each(["throws", "returns false", "leaves directory"])("retains metadata when cleanup %s", async (failure) => {
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
        if (failure === "returns false") return false
        if (failure === "leaves directory") return true
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

  it("rejects outside paths and manifest identity changes before deleting", async () => {
    const root = tempDirectory("jyycode-child-identity-project-")
    const runtime = tempDirectory("jyycode-child-identity-runtime-")
    const manager = new ChildWorkspace({ project: { root, vcs: "none" }, runtimeRoot: runtime })
    const created = await manager.create(manager.reserve("ses_root", "s1_t1"))

    expect(() =>
      assertRuntimePath({ runtimeRoot: runtime, candidate: path.join(runtime, "..", "outside"), label: "child" }),
    ).toThrow(WorkspacePathError)
    const manifest = JSON.parse(fs.readFileSync(created.baseline_manifest_path!, "utf8")) as Record<string, unknown>
    manifest.task_id = "s1_t2"
    fs.writeFileSync(created.baseline_manifest_path!, JSON.stringify(manifest))
    await expect(manager.remove(created.directory)).rejects.toMatchObject({
      recoverable: false,
      code: "PATH_IDENTITY_MISMATCH",
    })
    expect(fs.existsSync(created.directory)).toBe(true)
  })
})
