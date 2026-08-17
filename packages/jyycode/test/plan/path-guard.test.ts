import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { afterEach, describe, expect, it } from "bun:test"
import {
  PathGuardError,
  assertInside,
  assertOutputArtifact,
  canonicalExisting,
  resolveInside,
} from "../../src/plan/path-guard"

const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true })
})

function workspace() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "jyycode-path-guard-"))
  roots.push(root)
  return root
}

describe("plan path guard", () => {
  it("resolves workspace paths and rejects traversal or external roots", () => {
    const root = workspace()
    const nested = path.join(root, "nested")
    fs.mkdirSync(nested)
    expect(resolveInside(root, "nested/../report.md", "report")).toBe(path.join(root, "report.md"))
    expect(resolveInside(root, path.join(root, "nested", "report.md"), "report")).toBe(
      path.join(root, "nested", "report.md"),
    )
    expect(() => resolveInside(root, "../outside.md", "report")).toThrow(PathGuardError)
    expect(() => resolveInside(root, path.join(path.dirname(root), "outside.md"), "report")).toThrow(PathGuardError)
    if (process.platform === "win32")
      expect(() => resolveInside(root, "Z:\\outside.md", "report")).toThrow(PathGuardError)
  })

  it("canonicalizes existing symlinks and rejects escapes", () => {
    const root = workspace()
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), "jyycode-path-outside-"))
    roots.push(outside)
    const outsideFile = path.join(outside, "secret.md")
    fs.writeFileSync(outsideFile, "secret")
    const link = path.join(root, "link")
    fs.symlinkSync(outside, link, "junction")
    expect(canonicalExisting(link)).toBe(fs.realpathSync.native(outside))
    expect(() => resolveInside(root, path.join(link, "secret.md"), "artifact")).toThrow(PathGuardError)
  })

  it("validates output artifacts against the output subtree", () => {
    const root = workspace()
    const output = path.join(root, "output")
    fs.mkdirSync(output)
    const artifact = path.join(output, "report.md")
    fs.writeFileSync(artifact, "ready")
    expect(assertOutputArtifact({ workspaceRoot: root, outputRoot: output, artifact })).toBe(artifact)
    expect(() => assertOutputArtifact({ workspaceRoot: root, outputRoot: output, artifact: output })).toThrow(
      PathGuardError,
    )
    expect(() =>
      assertOutputArtifact({ workspaceRoot: root, outputRoot: output, artifact: path.join(root, "other.md") }),
    ).toThrow(PathGuardError)
    expect(
      assertOutputArtifact({ workspaceRoot: root, outputRoot: output, artifact: path.join(output, "pending.md") }),
    ).toBe(path.join(output, "pending.md"))
  })

  it("keeps boundary checks consistent for mixed separators and non-existing parents", () => {
    const root = workspace()
    const output = path.join(root, "generated")
    fs.mkdirSync(output)
    const mixed = `${output}${path.sep}nested/../pending.md`
    expect(resolveInside(root, mixed, "output")).toBe(path.join(output, "pending.md"))
    expect(() => assertInside(output, path.join(path.dirname(root), "outside.md"), "artifact")).toThrow(PathGuardError)
  })
})
