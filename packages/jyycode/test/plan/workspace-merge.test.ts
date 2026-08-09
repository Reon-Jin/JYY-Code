import fs from "node:fs"
import path from "node:path"
import { describe, expect, it } from "bun:test"
import { planWorkspaceMerge } from "../../src/plan/workspace-merge"
import { createMergeWorkspaceFixture } from "./hardening-fixtures"

function writeFile(root: string, relative: string, content: string | Uint8Array) {
  const pathname = path.join(root, relative)
  fs.mkdirSync(path.dirname(pathname), { recursive: true })
  fs.writeFileSync(pathname, content)
}

function copyTree(source: string, target: string) {
  fs.cpSync(source, target, { recursive: true, force: true })
}

function pathsOf(entries: Array<{ path: string }>) {
  return entries.map((entry) => entry.path)
}

describe("workspace three-way merge contract", () => {
  it("plans a child-only file addition for a non-Git snapshot", () => {
    const fixture = createMergeWorkspaceFixture()
    try {
      writeFile(fixture.baseline, "README.md", "base\n")
      copyTree(fixture.baseline, fixture.parent)
      copyTree(fixture.baseline, fixture.child)
      writeFile(fixture.child, "src/child-only.ts", "export const childOnly = true\n")

      const result = planWorkspaceMerge({
        base: fixture.baseline,
        main: fixture.parent,
        child: fixture.child,
      })
      expect(pathsOf(result.apply)).toEqual(["src/child-only.ts"])
      expect(result.conflicts).toEqual([])
    } finally {
      fixture.cleanup()
    }
  })

  it("uses the same result shape for a Git fake-worktree", () => {
    const fixture = createMergeWorkspaceFixture()
    try {
      writeFile(fixture.baseline, "src/shared.ts", "export const value = 1\n")
      copyTree(fixture.baseline, fixture.parent)
      copyTree(fixture.baseline, fixture.child)
      writeFile(fixture.child, "src/git-child.ts", "export const fromChild = true\n")

      const result = planWorkspaceMerge({
        base: fixture.baseline,
        main: fixture.parent,
        child: fixture.child,
      })
      expect(result).toEqual(expect.objectContaining({ apply: expect.any(Array), keep: expect.any(Array), delete: expect.any(Array), conflicts: expect.any(Array) }))
      expect(pathsOf(result.apply)).toContain("src/git-child.ts")
    } finally {
      fixture.cleanup()
    }
  })

  it("preserves parent-only edits and applies child-only edits", () => {
    const fixture = createMergeWorkspaceFixture()
    try {
      writeFile(fixture.baseline, "src/config.ts", "export const base = true\n")
      copyTree(fixture.baseline, fixture.parent)
      copyTree(fixture.baseline, fixture.child)
      writeFile(fixture.parent, "src/main-only.ts", "export const mainOnly = true\n")
      writeFile(fixture.child, "src/child-only.ts", "export const childOnly = true\n")

      const result = planWorkspaceMerge({ base: fixture.baseline, main: fixture.parent, child: fixture.child })
      expect(result.keep).toContain("src/main-only.ts")
      expect(pathsOf(result.apply)).toContain("src/child-only.ts")
    } finally {
      fixture.cleanup()
    }
  })

  it("merges non-overlapping edits in one text file", () => {
    const fixture = createMergeWorkspaceFixture()
    try {
      const base = "one\ntwo\nthree\nfour\n"
      writeFile(fixture.baseline, "src/file.ts", base)
      copyTree(fixture.baseline, fixture.parent)
      copyTree(fixture.baseline, fixture.child)
      writeFile(fixture.parent, "src/file.ts", "ONE\ntwo\nthree\nfour\n")
      writeFile(fixture.child, "src/file.ts", "one\ntwo\nTHREE\nfour\n")

      const result = planWorkspaceMerge({ base: fixture.baseline, main: fixture.parent, child: fixture.child })
      expect(pathsOf(result.apply)).toContain("src/file.ts")
      expect(result.conflicts).toEqual([])
      expect(result.apply.find((entry) => entry.path === "src/file.ts")?.content).toBe("ONE\ntwo\nTHREE\nfour\n")
    } finally {
      fixture.cleanup()
    }
  })

  it("reports overlapping text edits without choosing a side", () => {
    const fixture = createMergeWorkspaceFixture()
    try {
      writeFile(fixture.baseline, "src/file.ts", "one\ntwo\nthree\n")
      copyTree(fixture.baseline, fixture.parent)
      copyTree(fixture.baseline, fixture.child)
      writeFile(fixture.parent, "src/file.ts", "one\nMAIN\nthree\n")
      writeFile(fixture.child, "src/file.ts", "one\nCHILD\nthree\n")

      const result = planWorkspaceMerge({ base: fixture.baseline, main: fixture.parent, child: fixture.child })
      expect(result.conflicts).toEqual([expect.objectContaining({ path: "src/file.ts", kind: "content" })])
      expect(result.apply.some((entry) => entry.path === "src/file.ts")).toBe(false)
    } finally {
      fixture.cleanup()
    }
  })

  it("applies explicit child and main resolutions", () => {
    const fixture = createMergeWorkspaceFixture()
    try {
      writeFile(fixture.baseline, "src/config.ts", "export const value = \"base\"\n")
      copyTree(fixture.baseline, fixture.parent)
      copyTree(fixture.baseline, fixture.child)
      writeFile(fixture.parent, "src/config.ts", "export const value = \"main\"\n")
      writeFile(fixture.child, "src/config.ts", "export const value = \"child\"\n")

      const child = planWorkspaceMerge({
        base: fixture.baseline,
        main: fixture.parent,
        child: fixture.child,
        resolutions: [{ path: "src/config.ts", use: "child" }],
      })
      expect(child.conflicts).toEqual([])
      expect(child.apply.find((entry) => entry.path === "src/config.ts")?.content).toBe(
        "export const value = \"child\"\n",
      )

      writeFile(fixture.parent, "src/config.ts", "export const value = \"manually-resolved\"\n")
      const main = planWorkspaceMerge({
        base: fixture.baseline,
        main: fixture.parent,
        child: fixture.child,
        resolutions: [{ path: "src/config.ts", use: "main" }],
      })
      expect(main.conflicts).toEqual([])
      expect(main.keep).toContain("src/config.ts")
    } finally {
      fixture.cleanup()
    }
  })

  it("classifies add/add, delete/modify, binary, and symlink collisions", () => {
    const fixture = createMergeWorkspaceFixture()
    try {
      copyTree(fixture.baseline, fixture.parent)
      copyTree(fixture.baseline, fixture.child)
      writeFile(fixture.parent, "add-add.txt", "main\n")
      writeFile(fixture.child, "add-add.txt", "child\n")
      writeFile(fixture.baseline, "delete-modify.txt", "base\n")
      writeFile(fixture.parent, "delete-modify.txt", "main\n")
      writeFile(fixture.baseline, "binary.bin", new Uint8Array([0, 1, 2]))
      writeFile(fixture.parent, "binary.bin", new Uint8Array([0, 1, 3]))
      writeFile(fixture.child, "binary.bin", new Uint8Array([0, 1, 4]))
      fs.rmSync(path.join(fixture.child, "delete-modify.txt"), { force: true })
      try {
        fs.symlinkSync("target-main", path.join(fixture.parent, "link"), "file")
        fs.symlinkSync("target-child", path.join(fixture.child, "link"), "file")
      } catch {
        // Some Windows environments do not permit unprivileged symlink creation.
      }

      const result = planWorkspaceMerge({ base: fixture.baseline, main: fixture.parent, child: fixture.child })
      expect(result.conflicts).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ path: "add-add.txt", kind: "add_add" }),
          expect.objectContaining({ path: "delete-modify.txt", kind: "delete_modify" }),
          expect.objectContaining({ path: "binary.bin", kind: "binary" }),
        ]),
      )
      if (fs.existsSync(path.join(fixture.parent, "link")) || fs.lstatSync(path.join(fixture.parent, "link"), { throwIfNoEntry: false }))
        expect(result.conflicts).toEqual(expect.arrayContaining([expect.objectContaining({ path: "link", kind: "symlink" })]))
    } finally {
      fixture.cleanup()
    }
  })

  it("rejects traversal and .git paths", () => {
    const fixture = createMergeWorkspaceFixture()
    try {
      expect(() => planWorkspaceMerge({ base: fixture.baseline, main: fixture.parent, child: fixture.child, paths: ["../escape"] })).toThrow()
      expect(() => planWorkspaceMerge({ base: fixture.baseline, main: fixture.parent, child: fixture.child, paths: [".git/config"] })).toThrow()
    } finally {
      fixture.cleanup()
    }
  })

  it("returns a deterministic path order and keeps summaries bounded", () => {
    const fixture = createMergeWorkspaceFixture()
    try {
      copyTree(fixture.baseline, fixture.parent)
      copyTree(fixture.baseline, fixture.child)
      writeFile(fixture.child, "z.ts", "z\n")
      writeFile(fixture.child, "a.ts", "a\n")
      writeFile(fixture.child, "nested/m.ts", "m\n")
      const result = planWorkspaceMerge({ base: fixture.baseline, main: fixture.parent, child: fixture.child })
      expect(pathsOf(result.apply)).toEqual(["a.ts", "nested/m.ts", "z.ts"])
      expect(JSON.stringify(result).length).toBeLessThan(16_384)
    } finally {
      fixture.cleanup()
    }
  })
})
