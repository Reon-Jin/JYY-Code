import { describe, expect, test } from "bun:test"
import path from "node:path"
import { Global } from "@jyycode-ai/core/global"
import { isRuntimePath, runtimeExclusionGlobs, shouldExcludeRuntimePath } from "@/file/runtime-excludes"

describe("runtime search exclusions", () => {
  test("recognizes application data and workspace .jyycode paths", () => {
    expect(isRuntimePath(Global.Path.data)).toBe(true)
    expect(isRuntimePath(path.join("C:/workspace", ".jyycode", "session.jsonl"))).toBe(true)
    expect(isRuntimePath(path.join("C:/workspace", "src", "main.ts"))).toBe(false)
    expect(shouldExcludeRuntimePath("C:/workspace", ".jyycode/log/run.log")).toBe(true)
  })

  test("builds relative ripgrep globs", () => {
    expect(runtimeExclusionGlobs("C:/workspace")).toContain("!.jyycode/**")
  })
})
