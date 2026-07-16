import { describe, expect, it, vi } from "vitest"
import { createFakeDesktop } from "../../test/fake-desktop"
import { defaultDesktopSettings } from "./settings-preferences"
import { runDesktopUpdater } from "./desktop-updater"

describe("runDesktopUpdater", () => {
  it("does nothing when automatic checks are disabled", async () => {
    const desktop = createFakeDesktop()

    await runDesktopUpdater(desktop.bridge, { ...defaultDesktopSettings, updatePolicy: "off" })

    expect(desktop.bridge.checkForUpdate).not.toHaveBeenCalled()
  })

  it("notifies when the selected policy finds an update", async () => {
    const desktop = createFakeDesktop()
    vi.mocked(desktop.bridge.checkForUpdate).mockResolvedValueOnce({
      supported: true,
      available: true,
      version: "1.1.0",
    })

    await runDesktopUpdater(desktop.bridge, { ...defaultDesktopSettings, updatePolicy: "notify" })

    expect(desktop.bridge.sendNotification).toHaveBeenCalledWith({
      title: "JYYCode",
      body: "JYYCode 1.1.0 可用。请打开设置安装更新。",
    })
    expect(desktop.bridge.installAvailableUpdate).not.toHaveBeenCalled()
  })

  it("installs an update when automatic installation is selected", async () => {
    const desktop = createFakeDesktop()
    vi.mocked(desktop.bridge.checkForUpdate).mockResolvedValueOnce({
      supported: true,
      available: true,
      version: "1.1.0",
    })

    await runDesktopUpdater(desktop.bridge, { ...defaultDesktopSettings, updatePolicy: "install" })

    expect(desktop.bridge.installAvailableUpdate).toHaveBeenCalledOnce()
  })

  it("isolates network failures from application startup", async () => {
    const desktop = createFakeDesktop()
    vi.mocked(desktop.bridge.checkForUpdate).mockRejectedValueOnce(new Error("offline"))

    await expect(runDesktopUpdater(desktop.bridge, defaultDesktopSettings)).resolves.toBeUndefined()
  })
})
