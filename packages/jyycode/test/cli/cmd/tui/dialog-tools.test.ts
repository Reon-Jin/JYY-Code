import { describe, expect, test } from "bun:test"
import { toggleToolDisclosure } from "@/cli/cmd/tui/component/dialog-tools"

describe("tool disclosure dialog state", () => {
  test("persists an explicit deferred override for a direct tool", () => {
    expect(toggleToolDisclosure({ websearch: "direct" }, { id: "memory", mode: "direct" })).toEqual({
      policy: { websearch: "direct", memory: "deferred" },
      mode: "deferred",
    })
  })

  test("persists an explicit direct override for a deferred tool", () => {
    expect(toggleToolDisclosure(undefined, { id: "websearch", mode: "deferred" })).toEqual({
      policy: { websearch: "direct" },
      mode: "direct",
    })
  })
})
