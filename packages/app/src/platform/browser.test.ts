import { beforeEach, describe, expect, it, vi } from "vitest"
import { createBrowserBridge } from "./browser"
import { defaultDesktopSettings } from "../features/settings/settings-preferences"

describe("browser desktop settings persistence", () => {
  beforeEach(() => localStorage.clear())

  it("round-trips validated settings", async () => {
    const bridge = createBrowserBridge(localStorage)
    await bridge.saveSettings({ ...defaultDesktopSettings, startup: "home" })

    expect(await bridge.loadSettings()).toEqual({ ...defaultDesktopSettings, startup: "home" })
  })

  it("round-trips the ordered open-project workspace", async () => {
    const bridge = createBrowserBridge(localStorage)
    const location = {
      project: "C:\\work\\demo",
      sessionID: "ses_demo",
      openProjects: [
        { path: "C:\\work\\demo", sessionID: "ses_demo" },
        { path: "C:\\work\\other", sessionID: "ses_other" },
      ],
    }

    await bridge.saveLastLocation(location)

    expect(await bridge.loadLastLocation()).toEqual(location)
  })

  it("recovers from malformed storage", async () => {
    localStorage.setItem("jyycode.desktop.settings", "{not json")
    expect(await createBrowserBridge(localStorage).loadSettings()).toEqual(defaultDesktopSettings)

    localStorage.setItem("jyycode.desktop.settings", JSON.stringify({ startup: "bad", theme: "liquid" }))
    expect(await createBrowserBridge(localStorage).loadSettings()).toEqual(defaultDesktopSettings)
  })

  it("reports native capabilities as unsupported", async () => {
    const bridge = createBrowserBridge(localStorage)

    await expect(bridge.requestNotificationPermission()).resolves.toBe("unsupported")
    await expect(bridge.sendNotification({ title: "JYYCode", body: "Ready" })).resolves.toMatchObject({
      supported: false,
    })
    await expect(bridge.checkForUpdate()).resolves.toMatchObject({ supported: false, available: false })
    await expect(bridge.installAvailableUpdate()).resolves.toMatchObject({ supported: false })
  })

  it("downloads exported text through a browser Blob", async () => {
    const createObjectURL = vi.fn(() => "blob:memory")
    const revokeObjectURL = vi.fn()
    vi.stubGlobal("URL", { createObjectURL, revokeObjectURL })
    const click = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => undefined)

    await expect(createBrowserBridge(localStorage).saveTextFile("memory.json", "{}")).resolves.toEqual({
      supported: true,
      saved: true,
    })
    expect(createObjectURL).toHaveBeenCalledOnce()
    expect(click).toHaveBeenCalledOnce()
    expect(revokeObjectURL).toHaveBeenCalledWith("blob:memory")

    vi.unstubAllGlobals()
  })

  it("rejects native config reveal", async () => {
    await expect(createBrowserBridge(localStorage).revealConfigFile("C:\\jyycode.jsonc")).rejects.toThrow(
      "only available",
    )
  })
})
