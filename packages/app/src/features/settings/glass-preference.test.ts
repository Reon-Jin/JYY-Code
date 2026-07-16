import { beforeEach, describe, expect, it, vi } from "vitest"
import { createFakeDesktop } from "../../test/fake-desktop"
import { defaultDesktopSettings } from "./settings-preferences"
import { applyStoredGlass, reapplyGlassForTheme, setGlassPreference } from "./glass-preference"

describe("glass preference", () => {
  beforeEach(() => {
    document.documentElement.dataset.glass = "off"
  })

  it("applies the native effect before persisting a supported preference", async () => {
    const desktop = createFakeDesktop()
    const persist = vi.fn(async () => undefined)

    const next = await setGlassPreference({
      bridge: desktop.bridge,
      current: defaultDesktopSettings,
      enabled: true,
      persist,
    })

    expect(desktop.bridge.setWindowGlass).toHaveBeenCalledWith(true, "dark")
    expect(persist).toHaveBeenCalledWith({ ...defaultDesktopSettings, glass: "on" })
    expect(next.glass).toBe("on")
    expect(document.documentElement.dataset.glass).toBe("on")
  })

  it("does not persist unsupported glass and keeps the solid fallback", async () => {
    const desktop = createFakeDesktop()
    vi.mocked(desktop.bridge.setWindowGlass).mockResolvedValueOnce({ supported: false, reason: "unsupported OS" })
    const persist = vi.fn(async () => undefined)

    await expect(
      setGlassPreference({ bridge: desktop.bridge, current: defaultDesktopSettings, enabled: true, persist }),
    ).rejects.toThrow("unsupported OS")

    expect(persist).not.toHaveBeenCalled()
    expect(document.documentElement.dataset.glass).toBe("off")
  })

  it("restores the native effect and DOM attribute when persistence fails", async () => {
    const desktop = createFakeDesktop()
    const persist = vi.fn(async () => Promise.reject(new Error("store unavailable")))

    await expect(
      setGlassPreference({ bridge: desktop.bridge, current: defaultDesktopSettings, enabled: true, persist }),
    ).rejects.toThrow("store unavailable")

    expect(desktop.bridge.setWindowGlass).toHaveBeenNthCalledWith(1, true, "dark")
    expect(desktop.bridge.setWindowGlass).toHaveBeenNthCalledWith(2, false, "dark")
    expect(document.documentElement.dataset.glass).toBe("off")
  })

  it("reapplies enabled native glass when the theme changes", async () => {
    const desktop = createFakeDesktop()
    const settings = { ...defaultDesktopSettings, glass: "on" as const }

    await reapplyGlassForTheme(desktop.bridge, settings, "light")

    expect(desktop.bridge.setWindowGlass).toHaveBeenCalledWith(true, "light")
  })

  it("applies stored glass once and falls back when unavailable", async () => {
    const desktop = createFakeDesktop()
    const settings = { ...defaultDesktopSettings, glass: "on" as const }
    await applyStoredGlass(desktop.bridge, settings)
    expect(document.documentElement.dataset.glass).toBe("on")

    vi.mocked(desktop.bridge.setWindowGlass).mockResolvedValueOnce({ supported: false, reason: "unsupported" })
    await expect(applyStoredGlass(desktop.bridge, settings)).rejects.toThrow("unsupported")
    expect(document.documentElement.dataset.glass).toBe("off")
  })
})
