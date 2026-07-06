import { describe, expect, test } from "bun:test"
import path from "path"
import { Memory } from "@/memory/memory"

describe("memory", () => {
  test("uses the single fixed workspace memory directory", () => {
    expect(Memory.DIRECTORY).toBe(path.normalize("D:/jyycode/memory"))
  })

  test("empty stores use the v3 JSON envelope", () => {
    expect(JSON.parse(Memory.serializeStore("memory", []))).toEqual({
      schemaVersion: 3,
      lastCompactedAt: null,
      entries: [],
    })
  })
})
