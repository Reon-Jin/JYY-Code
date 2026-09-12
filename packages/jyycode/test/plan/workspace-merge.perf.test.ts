import fs from "node:fs"
import path from "node:path"
import { afterEach, describe, expect, it } from "bun:test"
import { __mergeScanStats, buildScanFilter, planWorkspaceMerge, prepareWorkspaceMerge } from "../../src/plan/workspace-merge"
import { createMergeWorkspaceFixture } from "./hardening-fixtures"

function writeFile(root: string, relative: string, content: string) {
  const pathname = path.join(root, relative)
  fs.mkdirSync(path.dirname(pathname), { recursive: true })
  fs.writeFileSync(pathname, content)
}

const cleanups: Array<() => void> = []
afterEach(() => {
  while (cleanups.length) cleanups.pop()!()
})

describe("workspace merge scan budget", () => {
  it("does not recurse into dependency directories when no path filter is available", () => {
    const fixture = createMergeWorkspaceFixture()
    cleanups.push(fixture.cleanup)
    writeFile(fixture.baseline, "src/app.ts", "export const value = 1\n")
    writeFile(fixture.baseline, "node_modules/pkg/index.js", "module.exports = 1\n")
    fs.cpSync(fixture.baseline, fixture.parent, { recursive: true })
    fs.cpSync(fixture.baseline, fixture.child, { recursive: true })
    writeFile(fixture.child, "src/app.ts", "export const value = 2\n")

    const result = planWorkspaceMerge({ base: fixture.baseline, main: fixture.parent, child: fixture.child })

    expect(result.apply.map((entry) => entry.path)).toEqual(["src/app.ts"])
    expect(__mergeScanStats.scannedPaths).not.toContain("node_modules/pkg/index.js")
  })

  it("does not retain file bodies after scanning", () => {
    const fixture = createMergeWorkspaceFixture()
    cleanups.push(fixture.cleanup)
    const payload = "x".repeat(2 * 1024 * 1024)
    writeFile(fixture.baseline, "big.txt", payload)
    writeFile(fixture.baseline, "unchanged.txt", "same\n")
    fs.cpSync(fixture.baseline, fixture.parent, { recursive: true })
    fs.cpSync(fixture.baseline, fixture.child, { recursive: true })
    writeFile(fixture.child, "big.txt", `${payload}y`)

    const prepared = prepareWorkspaceMerge({ base: fixture.baseline, main: fixture.parent, child: fixture.child })
    const entry = prepared.main.get("unchanged.txt")!
    expect((entry as Record<string, unknown>).bytes).toBeUndefined()
    expect((entry as Record<string, unknown>).text).toBeUndefined()
    expect(prepared.plan.apply.map((item) => item.path)).toEqual(["big.txt"])
  })

  it("uses a directory index instead of scanning every candidate path", () => {
    const fixture = createMergeWorkspaceFixture()
    cleanups.push(fixture.cleanup)
    for (let index = 0; index < 200; index++) writeFile(fixture.baseline, `pkg${index}/file.txt`, "base\n")
    fs.cpSync(fixture.baseline, fixture.parent, { recursive: true })
    fs.cpSync(fixture.baseline, fixture.child, { recursive: true })
    writeFile(fixture.child, "pkg42/file.txt", "child\n")

    const filter = buildScanFilter(new Set(["pkg42/file.txt"]))
    expect(filter.dirs.has("pkg42")).toBe(true)

    __mergeScanStats.scannedPaths = []
    const result = planWorkspaceMerge({
      base: fixture.baseline,
      main: fixture.parent,
      child: fixture.child,
      __scanFilter: filter,
    })

    expect(result.apply.map((entry) => entry.path)).toEqual(["pkg42/file.txt"])
    expect(__mergeScanStats.scannedPaths).toEqual(["pkg42/file.txt", "pkg42/file.txt", "pkg42/file.txt"])
  })

  it("merges large both-sides-changed files without a quadratic allocation", () => {
    const fixture = createMergeWorkspaceFixture()
    cleanups.push(fixture.cleanup)
    const lines = Array.from({ length: 8000 }, (_, index) => `line-${index}`)
    writeFile(fixture.baseline, "large.txt", `${lines.join("\n")}\n`)
    fs.cpSync(fixture.baseline, fixture.parent, { recursive: true })
    fs.cpSync(fixture.baseline, fixture.child, { recursive: true })
    const parent = [...lines]
    parent[10] = "parent-10"
    const child = [...lines]
    child[7000] = "child-7000"
    writeFile(fixture.parent, "large.txt", `${parent.join("\n")}\n`)
    writeFile(fixture.child, "large.txt", `${child.join("\n")}\n`)

    const before = process.memoryUsage().heapUsed
    const result = planWorkspaceMerge({ base: fixture.baseline, main: fixture.parent, child: fixture.child })
    const after = process.memoryUsage().heapUsed

    expect(result.conflicts).toEqual([])
    expect(result.apply.map((entry) => entry.path)).toEqual(["large.txt"])
    expect(after - before).toBeLessThan(64 * 1024 * 1024)
  })
})
