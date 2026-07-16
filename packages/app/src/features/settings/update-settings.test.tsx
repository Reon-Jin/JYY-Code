import { cleanup, render, screen, waitFor } from "@solidjs/testing-library"
import userEvent from "@testing-library/user-event"
import { afterEach, describe, expect, it, vi } from "vitest"
import { I18nProvider } from "../../i18n/i18n-context"
import { DesktopBridgeProvider } from "../../platform/context"
import { createFakeDesktop } from "../../test/fake-desktop"
import { UpdateSettings } from "./update-settings"

function renderUpdates() {
  const desktop = createFakeDesktop()
  render(() => (
    <DesktopBridgeProvider bridge={desktop.bridge}>
      <I18nProvider><UpdateSettings /></I18nProvider>
    </DesktopBridgeProvider>
  ))
  return desktop
}

afterEach(cleanup)

describe("UpdateSettings", () => {
  it("persists the automatic update policy", async () => {
    const desktop = renderUpdates()
    const policy = await screen.findByRole("combobox", { name: "自动更新策略" })

    await userEvent.setup().selectOptions(policy, "off")

    await waitFor(() => expect(desktop.settings().updatePolicy).toBe("off"))
  })

  it("reports an up-to-date installation", async () => {
    const desktop = renderUpdates()
    vi.mocked(desktop.bridge.checkForUpdate).mockResolvedValueOnce({ supported: true, available: false })

    await userEvent.setup().click(await screen.findByRole("button", { name: "立即检查" }))

    expect(await screen.findByText("当前已是最新版本")).toBeVisible()
  })

  it("shows release notes and installs an available update", async () => {
    const desktop = renderUpdates()
    vi.mocked(desktop.bridge.checkForUpdate).mockResolvedValueOnce({
      supported: true,
      available: true,
      currentVersion: "1.0.0",
      version: "1.1.0",
      notes: "Improved updater",
    })

    const user = userEvent.setup()
    await user.click(await screen.findByRole("button", { name: "立即检查" }))
    expect(await screen.findByText("发现 1.1.0")).toBeVisible()
    expect(screen.getByText("Improved updater")).toBeVisible()

    await user.click(screen.getByRole("button", { name: "安装并重启" }))
    await waitFor(() => expect(desktop.bridge.installAvailableUpdate).toHaveBeenCalledOnce())
  })
})
