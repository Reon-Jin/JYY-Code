import { describe, expect, it } from "vitest"
import { permissionModeFromRules, permissionRulesForMode } from "./permission-mode"

describe("Agent permission modes", () => {
  it("maps the three modes to session-level overrides", () => {
    expect(permissionRulesForMode("request")).toEqual([{ permission: "*", pattern: "*", action: "ask" }])
    expect(permissionRulesForMode("auto")).toEqual([])
    expect(permissionRulesForMode("full")).toEqual([{ permission: "*", pattern: "*", action: "allow" }])
  })

  it("uses the last effective wildcard override and treats custom rules as automatic", () => {
    expect(permissionModeFromRules(undefined)).toBe("auto")
    expect(permissionModeFromRules([{ permission: "edit", pattern: "*", action: "ask" }])).toBe("auto")
    expect(
      permissionModeFromRules([
        { permission: "*", pattern: "*", action: "allow" },
        { permission: "*", pattern: "*", action: "ask" },
      ]),
    ).toBe("request")
  })
})
