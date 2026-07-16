import { describe, expect, it } from "vitest"
import { createFakeDesktop } from "../../test/fake-desktop"
import { defaultDesktopSettings, parseDesktopSettings } from "./settings-preferences"

describe("parseDesktopSettings", () => {
  it("uses safe defaults for absent and malformed values", () => {
    expect(parseDesktopSettings(undefined)).toEqual(defaultDesktopSettings)
    expect(parseDesktopSettings({ startup: "bad", theme: "liquid" })).toEqual(defaultDesktopSettings)
  })

  it("accepts supported values field by field", () => {
    expect(parseDesktopSettings({ startup: "home", theme: "light" })).toEqual({
      ...defaultDesktopSettings,
      startup: "home",
      theme: "light",
    })
    expect(parseDesktopSettings({ startup: "home", theme: "bad" })).toEqual({
      ...defaultDesktopSettings,
      startup: "home",
      theme: "dark",
    })
  })

  it("migrates legacy settings and ignores unknown fields", () => {
    expect(parseDesktopSettings({ startup: "home", theme: "light", obsolete: true })).toEqual({
      ...defaultDesktopSettings,
      startup: "home",
      theme: "light",
    })
  })

  it("validates every new preference independently", () => {
    expect(
      parseDesktopSettings({
        locale: "en-US",
        glass: "on",
        notifications: { completion: false, permission: true, question: false, ignored: false },
        updatePolicy: "install",
      }),
    ).toEqual({
      ...defaultDesktopSettings,
      locale: "en-US",
      glass: "on",
      notifications: { completion: false, permission: true, question: false },
      updatePolicy: "install",
    })

    expect(
      parseDesktopSettings({
        locale: "fr-FR",
        glass: "auto",
        notifications: { completion: false, permission: "yes" },
        updatePolicy: "sometimes",
      }),
    ).toEqual({
      ...defaultDesktopSettings,
      notifications: { completion: false, permission: true, question: true },
    })
  })
})

describe("fake desktop settings", () => {
  it("round-trips settings without exposing mutable references", async () => {
    const desktop = createFakeDesktop({ settings: { ...defaultDesktopSettings, startup: "home", theme: "light" } })

    const loaded = await desktop.bridge.loadSettings()
    loaded.theme = "dark"
    expect(desktop.settings()).toEqual({ ...defaultDesktopSettings, startup: "home", theme: "light" })

    const next = { ...defaultDesktopSettings, startup: "restore", theme: "dark" } as const
    await desktop.bridge.saveSettings(next)
    expect(desktop.settings()).toEqual(next)
  })
})
