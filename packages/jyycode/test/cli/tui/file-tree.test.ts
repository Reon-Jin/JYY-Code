import { describe, expect, test } from "bun:test"
import { buildFileTree, filterHidden, isTextFile, previewLines } from "../../../src/cli/cmd/tui/feature-plugins/system/file-tree"

describe("file tree logic", () => {
  test("扁平列表构建嵌套树", () => {
    const tree = buildFileTree(["a/b.ts", "a/c.ts", "d.ts"])
    expect(tree[0]!.name).toBe("a")
    expect(tree[0]!.children).toHaveLength(2)
    expect(tree[0]!.children![0]!.path).toBe("a/b.ts")
    expect(tree[1]!.name).toBe("d.ts")
    expect(tree[1]!.children).toBeUndefined()
  })

  test("隐藏 .git / node_modules", () => {
    expect(filterHidden([".git", "node_modules", "src"])).toEqual(["src"])
    expect(filterHidden([])).toEqual([])
  })

  test("文本/二进制判定", () => {
    expect(isTextFile("src/a.ts")).toBe(true)
    expect(isTextFile("README.md")).toBe(true)
    expect(isTextFile("logo.png")).toBe(false)
    expect(isTextFile("bundle.zip")).toBe(false)
    expect(isTextFile("data.db")).toBe(false)
  })

  test("预览行数截断", () => {
    const content = Array.from({ length: 300 }, (_, i) => `line${i}`).join("\n")
    expect(previewLines(content)).toHaveLength(200)
    expect(previewLines("a\nb")).toHaveLength(2)
  })
})
