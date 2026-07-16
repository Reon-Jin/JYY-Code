import { describe, expect, it } from "vitest"
import { createFakeDesktop } from "../../test/fake-desktop"
import { defaultDesktopSettings, parseDesktopSettings } from "./settings-preferences"

describe("parseDesktopSettings", () => {
  it("uses safe defaults for absent and malformed values", () => {
    expect(parseDesktopSettings(undefined)).toEqual({ startup: "restore", theme: "dark" })
    expect(parseDesktopSettings({ startup: "bad", theme: "liquid" })).toEqual(defaultDesktopSettings)
  })

  it("accepts supported values field by field", () => {
    expect(parseDesktopSettings({ startup: "home", theme: "light" })).toEqual({
      startup: "home",
      theme: "light",
    })
    expect(parseDesktopSettings({ startup: "home", theme: "bad" })).toEqual({
      startup: "home",
      theme: "dark",
    })
  })
})

describe("fake desktop settings", () => {
  it("round-trips settings without exposing mutable references", async () => {
    const desktop = createFakeDesktop({ settings: { startup: "home", theme: "light" } })

    const loaded = await desktop.bridge.loadSettings()
    loaded.theme = "dark"
    expect(desktop.settings()).toEqual({ startup: "home", theme: "light" })

    const next = { startup: "restore", theme: "dark" } as const
    await desktop.bridge.saveSettings(next)
    expect(desktop.settings()).toEqual(next)
  })
})
