import { describe, expect, it } from "vitest"
import { createFakeDesktop } from "../../test/fake-desktop"
import { defaultDesktopSettings, parseDesktopSettings } from "./settings-preferences"

describe("parseDesktopSettings", () => {
  it("uses safe defaults for absent and malformed values", () => {
    expect(parseDesktopSettings(undefined)).toEqual(defaultDesktopSettings)
    expect(parseDesktopSettings({ startup: "bad", theme: "liquid" })).toEqual(defaultDesktopSettings)
  })

  it("accepts supported values field by field", () => {
    expect(parseDesktopSettings({ startup: "home" })).toEqual({
      ...defaultDesktopSettings,
      startup: "home",
    })
    expect(parseDesktopSettings({ startup: "bad" })).toEqual(defaultDesktopSettings)
  })

  it("migrates legacy settings and ignores unknown fields", () => {
    expect(parseDesktopSettings({ startup: "home", theme: "light", glass: "on", obsolete: true })).toEqual({
      ...defaultDesktopSettings,
      startup: "home",
    })
  })

  it("validates every new preference independently", () => {
    expect(
      parseDesktopSettings({
        locale: "en-US",
        notifications: { completion: false, permission: true, question: false, ignored: false },
        updatePolicy: "install",
        soundEffects: false,
      }),
    ).toEqual({
      ...defaultDesktopSettings,
      locale: "en-US",
      notifications: { completion: false, permission: true, question: false },
      updatePolicy: "install",
      soundEffects: false,
    })

    expect(
      parseDesktopSettings({
        locale: "fr-FR",
        notifications: { completion: false, permission: "yes" },
        updatePolicy: "sometimes",
        soundEffects: "yes",
      }),
    ).toEqual({
      ...defaultDesktopSettings,
      notifications: { completion: false, permission: true, question: true },
      soundEffects: true,
    })
  })
})

describe("fake desktop settings", () => {
  it("round-trips settings without exposing mutable references", async () => {
    const desktop = createFakeDesktop({ settings: { ...defaultDesktopSettings, startup: "home" } })

    const loaded = await desktop.bridge.loadSettings()
    loaded.startup = "restore"
    expect(desktop.settings()).toEqual({ ...defaultDesktopSettings, startup: "home" })

    const next = { ...defaultDesktopSettings, startup: "restore" } as const
    await desktop.bridge.saveSettings(next)
    expect(desktop.settings()).toEqual(next)
  })
})
