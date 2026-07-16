import { cleanup, render, screen, waitFor } from "@solidjs/testing-library"
import userEvent from "@testing-library/user-event"
import { afterEach, describe, expect, it, vi } from "vitest"
import { DesktopBridgeProvider } from "../../platform/context"
import { createFakeDesktop } from "../../test/fake-desktop"
import { GeneralSettings } from "./general-settings"

function renderGeneral() {
  const desktop = createFakeDesktop()
  render(() => (
    <DesktopBridgeProvider bridge={desktop.bridge}>
      <GeneralSettings />
    </DesktopBridgeProvider>
  ))
  return desktop
}

describe("GeneralSettings", () => {
  afterEach(() => {
    cleanup()
    document.documentElement.dataset.theme = "dark"
  })

  it("persists startup and appearance preferences", async () => {
    const desktop = renderGeneral()
    const user = userEvent.setup()

    await user.click(await screen.findByRole("radio", { name: "启动时显示 Home" }))
    await waitFor(() =>
      expect(desktop.bridge.saveSettings).toHaveBeenCalledWith({ startup: "home", theme: "dark" }),
    )

    await user.click(screen.getByRole("radio", { name: "浅色" }))
    expect(document.documentElement.dataset.theme).toBe("light")
    await waitFor(() => expect(desktop.settings().theme).toBe("light"))
  })

  it("rolls back the theme when persistence fails", async () => {
    const desktop = renderGeneral()
    vi.mocked(desktop.bridge.saveSettings).mockRejectedValueOnce(new Error("store unavailable"))

    await userEvent.setup().click(await screen.findByRole("radio", { name: "浅色" }))

    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent("store unavailable"))
    expect(document.documentElement.dataset.theme).toBe("dark")
    expect(screen.getByRole("radio", { name: "深色" })).toBeChecked()
  })

  it("shows deferred controls as disabled and coming soon", () => {
    renderGeneral()

    expect(screen.getByLabelText("语言")).toBeDisabled()
    expect(screen.getByLabelText("Apple 风格液态玻璃")).toBeDisabled()
    for (const label of ["回复完成", "等待权限", "Agent 提问"]) {
      expect(screen.getByLabelText(label)).toBeDisabled()
    }
    expect(screen.getAllByText("即将推出").length).toBeGreaterThanOrEqual(3)
  })
})
