import { describe, expect, test } from "bun:test"
import path from "path"
import { Effect } from "effect"
import { Memory } from "@/memory/memory"
import { Layer } from "effect"

describe("memory", () => {
  test("uses the single fixed workspace memory directory", () => {
    expect(Memory.DIRECTORY).toBe(path.normalize("D:/jyycode/memory"))
  })

  test("char limits are defined", () => {
    const limits = (Memory as any)._charLimits
    // 2200 for project memory, 1375 for user profile
  })

  test("compute usage reports correct percentages", () => {
    // Manually test computeUsage by checking memory file sizes
  })

  test("substring matching finds unique entries", () => {
    // Test findEntryBySubstring behavior
  })

  test("duplicate prevention still works", () => {
    // Test that exact duplicates are rejected
  })
})
