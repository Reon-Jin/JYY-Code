import { describe, expect, test } from "bun:test"
import path from "path"
import { Global } from "@jyycode-ai/core/global"
import { Memory } from "@/memory/memory"

describe("memory", () => {
  test("uses the platform data directory as the canonical memory store", () => {
    expect(Memory.LEGACY_DIRECTORY).toBe(path.normalize("D:/jyycode/memory"))
    expect(Memory.DIRECTORY).toBe(path.join(Global.Path.data, "memory"))
  })

  test("empty stores use the v3 JSON envelope", () => {
    expect(JSON.parse(Memory.serializeStore("memory", []))).toEqual({
      schemaVersion: 3,
      lastCompactedAt: null,
      entries: [],
    })
  })
})
