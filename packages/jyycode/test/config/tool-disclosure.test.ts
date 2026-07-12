import { describe, expect, test } from "bun:test"
import { Schema } from "effect"
import { Config } from "@/config/config"

describe("tool disclosure config", () => {
  test("accepts direct and deferred per-tool overrides", () => {
    const config = Schema.decodeUnknownSync(Config.Info)({
      tool_disclosure: {
        memory: "direct",
        websearch: "deferred",
      },
    })

    expect(config.tool_disclosure).toEqual({ memory: "direct", websearch: "deferred" })
  })

  test("rejects unknown disclosure modes", () => {
    expect(() => Schema.decodeUnknownSync(Config.Info)({ tool_disclosure: { websearch: "sometimes" } })).toThrow()
  })
})
