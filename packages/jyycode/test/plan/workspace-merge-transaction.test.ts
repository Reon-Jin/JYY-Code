import fs from "node:fs"
import path from "node:path"
import { describe, expect, it } from "bun:test"
import { applyWorkspaceMerge, prepareWorkspaceMerge } from "../../src/plan/workspace-merge"
import { createMergeWorkspaceFixture } from "./hardening-fixtures"

function writeFile(root: string, relative: string, content: string) {
  const pathname = path.join(root, relative)
  fs.mkdirSync(path.dirname(pathname), { recursive: true })
  fs.writeFileSync(pathname, content)
}

function input(fixture: ReturnType<typeof createMergeWorkspaceFixture>) {
  return {
    base: fixture.baseline,
    main: fixture.parent,
    child: fixture.child,
    journal_directory: path.join(fixture.root, "runtime", "merge-journal"),
  }
}

describe("workspace merge transaction", () => {
  it("stages changes before replacing parent files", () => {
    const fixture = createMergeWorkspaceFixture()
    try {
      writeFile(fixture.baseline, "src/child.ts", "base\n")
      fs.cpSync(fixture.baseline, fixture.parent, { recursive: true })
      fs.cpSync(fixture.baseline, fixture.child, { recursive: true })
      writeFile(fixture.child, "src/child.ts", "child\n")
      let observedBeforeApply = ""
      const result = applyWorkspaceMerge(input(fixture), {
        beforeApply: () => {
          observedBeforeApply = fs.readFileSync(path.join(fixture.parent, "src", "child.ts"), "utf8")
        },
      })
      expect(observedBeforeApply).toBe("base\n")
      expect(result.status).toBe("merged")
      expect(fs.readFileSync(path.join(fixture.parent, "src", "child.ts"), "utf8")).toBe("child\n")
      expect(fs.existsSync(path.join(fixture.root, "runtime", "merge-journal"))).toBe(true)
    } finally {
      fixture.cleanup()
    }
  })

  it("reuses merge preflight data for transactional apply", () => {
    const fixture = createMergeWorkspaceFixture()
    try {
      writeFile(fixture.baseline, "src/child.ts", "base\n")
      fs.cpSync(fixture.baseline, fixture.parent, { recursive: true })
      fs.cpSync(fixture.baseline, fixture.child, { recursive: true })
      writeFile(fixture.child, "src/child.ts", "child\n")

      const mergeInput = input(fixture)
      const prepared = prepareWorkspaceMerge(mergeInput)
      const result = applyWorkspaceMerge(mergeInput, {}, prepared)

      expect(result.status).toBe("merged")
      expect(fs.readFileSync(path.join(fixture.parent, "src", "child.ts"), "utf8")).toBe("child\n")
    } finally {
      fixture.cleanup()
    }
  })

  it("rolls back every parent write when a later write fails", () => {
    const fixture = createMergeWorkspaceFixture()
    try {
      writeFile(fixture.baseline, "a.txt", "base-a\n")
      writeFile(fixture.baseline, "b.txt", "base-b\n")
      fs.cpSync(fixture.baseline, fixture.parent, { recursive: true })
      fs.cpSync(fixture.baseline, fixture.child, { recursive: true })
      writeFile(fixture.child, "a.txt", "child-a\n")
      writeFile(fixture.child, "b.txt", "child-b\n")
      const result = applyWorkspaceMerge(input(fixture), { failAfterWrites: 1 })
      expect(result.status).toBe("failed")
      expect(fs.readFileSync(path.join(fixture.parent, "a.txt"), "utf8")).toBe("base-a\n")
      expect(fs.readFileSync(path.join(fixture.parent, "b.txt"), "utf8")).toBe("base-b\n")
    } finally {
      fixture.cleanup()
    }
  })

  it("detects a parent fingerprint change between planning and apply", () => {
    const fixture = createMergeWorkspaceFixture()
    try {
      writeFile(fixture.baseline, "src/target.ts", "base\n")
      fs.cpSync(fixture.baseline, fixture.parent, { recursive: true })
      fs.cpSync(fixture.baseline, fixture.child, { recursive: true })
      writeFile(fixture.child, "src/target.ts", "child\n")
      const result = applyWorkspaceMerge(input(fixture), {
        beforeApply: () => writeFile(fixture.parent, "src/target.ts", "edited-after-plan\n"),
      })
      expect(result.status).toBe("stale")
      expect(fs.readFileSync(path.join(fixture.parent, "src", "target.ts"), "utf8")).toBe("edited-after-plan\n")
    } finally {
      fixture.cleanup()
    }
  })

  it("resumes an interrupted running journal after a new manager call", () => {
    const fixture = createMergeWorkspaceFixture()
    try {
      writeFile(fixture.baseline, "a.txt", "base-a\n")
      writeFile(fixture.baseline, "b.txt", "base-b\n")
      fs.cpSync(fixture.baseline, fixture.parent, { recursive: true })
      fs.cpSync(fixture.baseline, fixture.child, { recursive: true })
      writeFile(fixture.child, "a.txt", "child-a\n")
      writeFile(fixture.child, "b.txt", "child-b\n")
      expect(() => applyWorkspaceMerge(input(fixture), { interruptAfterWrites: 1 })).toThrow("simulated interruption")
      const resumed = applyWorkspaceMerge(input(fixture))
      expect(resumed.status).toBe("merged")
      expect(fs.readFileSync(path.join(fixture.parent, "a.txt"), "utf8")).toBe("child-a\n")
      expect(fs.readFileSync(path.join(fixture.parent, "b.txt"), "utf8")).toBe("child-b\n")
    } finally {
      fixture.cleanup()
    }
  })

  it("returns already_merged from the durable journal without duplicating writes", () => {
    const fixture = createMergeWorkspaceFixture()
    try {
      writeFile(fixture.baseline, "child.txt", "base\n")
      fs.cpSync(fixture.baseline, fixture.parent, { recursive: true })
      fs.cpSync(fixture.baseline, fixture.child, { recursive: true })
      writeFile(fixture.child, "child.txt", "child\n")
      expect(applyWorkspaceMerge(input(fixture)).status).toBe("merged")
      const second = applyWorkspaceMerge(input(fixture))
      expect(second.status).toBe("already_merged")
      expect(second.applied_paths).toEqual(["child.txt"])
    } finally {
      fixture.cleanup()
    }
  })
})
