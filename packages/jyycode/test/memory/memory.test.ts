import { describe, expect, test } from "bun:test"
import path from "path"
import { Global } from "@jyycode-ai/core/global"
import { Memory } from "@/memory/memory"

describe("memory", () => {
  test("uses the global data directory and retains the old path only as a migration source", () => {
    expect(Memory.DIRECTORY).toBe(path.join(Global.Path.data, "memory"))
    expect(Memory.LEGACY_DIRECTORY).toBe(path.normalize("D:/jyycode/memory"))
  })

  test("empty stores use the v3 JSON envelope", () => {
    expect(JSON.parse(Memory.serializeStore("memory", []))).toEqual({
      schemaVersion: 3,
      lastCompactedAt: null,
      entries: [],
    })
  })
})
