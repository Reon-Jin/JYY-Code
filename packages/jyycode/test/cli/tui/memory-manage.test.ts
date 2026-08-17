import { describe, expect, test } from "bun:test"
import type { GlobalMemoryEntry } from "@jyycode-ai/sdk/v2"
import {
  memoryScopeLabel,
  memorySearchFilter,
  memoryImportanceLabel,
  memoryEntrySummary,
  memoryDateLabel,
  type MemoryScope,
} from "../../../src/cli/cmd/tui/feature-plugins/system/memory-manage"

const entry = (overrides: Partial<GlobalMemoryEntry> = {}): GlobalMemoryEntry => ({
  id: "m1",
  scope: "user",
  importance: 5,
  keywords: ["parser"],
  content: "Fix bug: root cause in parser module",
  ...overrides,
} as GlobalMemoryEntry)

describe("memory-manage logic", () => {
  test("search filter 按内容与关键词过滤", () => {
    const items = [
      entry({ id: "a", content: "Fix bug: root cause in parser" }),
      entry({ id: "b", content: "Deploy notes: run pipeline", keywords: ["deploy"] }),
    ]
    expect(memorySearchFilter(items, "parser")).toHaveLength(1)
    expect(memorySearchFilter(items, "parser")[0]!.id).toBe("a")
    expect(memorySearchFilter(items, "")).toHaveLength(2)
    expect(memorySearchFilter(items, "PIPELINE")).toHaveLength(1)
    expect(memorySearchFilter(items, "deploy")).toHaveLength(1)
    expect(memorySearchFilter(items, "nope")).toHaveLength(0)
  })

  test("scope label 映射", () => {
    expect(memoryScopeLabel("user")).toBe("User")
    expect(memoryScopeLabel("task")).toBe("Task")
    expect(memoryScopeLabel("experience")).toBe("Experience")
  })

  test("importance 分级", () => {
    expect(memoryImportanceLabel(9)).toBe("高")
    expect(memoryImportanceLabel(8)).toBe("高")
    expect(memoryImportanceLabel(5)).toBe("中")
    expect(memoryImportanceLabel(4)).toBe("中")
    expect(memoryImportanceLabel(2)).toBe("低")
  })

  test("entry 摘要取首行并截断", () => {
    expect(memoryEntrySummary(entry())).toBe("Fix bug: root cause in parser module")
    const long = "x".repeat(100)
    expect(memoryEntrySummary(entry({ content: long }))).toHaveLength(60)
    expect(memoryEntrySummary(entry({ content: "" }))).toBe("(空)")
  })

  test("date/kind 标签", () => {
    expect(memoryDateLabel(entry({ date: "2026-08-17T00:00:00Z" }))).toBe("2026-08-17")
    expect(memoryDateLabel(entry({ scope: "task" as const, sessionID: "s1", date: "2026-08-17" }))).toBe("2026-08-17")
  })

  test("scope 类型枚举可用", () => {
    const scopes: MemoryScope[] = ["user", "task", "experience"]
    expect(scopes).toHaveLength(3)
  })
})
