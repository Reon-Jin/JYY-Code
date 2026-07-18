import { describe, expect, test } from "bun:test"
import path from "path"
import { Memory } from "@/memory/memory"

describe("memory", () => {
  test("uses the workspace JSON directory as the canonical memory store", () => {
    expect(Memory.LEGACY_DIRECTORY).toBe(path.normalize("D:/jyycode/memory"))
    expect(Memory.DIRECTORY).toBe(Memory.LEGACY_DIRECTORY)
  })

  test("empty stores use the v3 JSON envelope", () => {
    expect(JSON.parse(Memory.serializeStore("memory", []))).toEqual({
      schemaVersion: 3,
      lastCompactedAt: null,
      entries: [],
    })
  })
})
