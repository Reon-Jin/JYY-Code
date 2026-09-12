import fs from "node:fs"
import path from "node:path"
import { afterEach, describe, expect, it } from "bun:test"
import { __mergeScanStats, buildScanFilter, planWorkspaceMerge } from "../../src/plan/workspace-merge"
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
})
