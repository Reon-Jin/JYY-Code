import { cleanup, render, screen, waitFor } from "@solidjs/testing-library"
import userEvent from "@testing-library/user-event"
import { afterEach, describe, expect, it, vi } from "vitest"
import { DesktopBridgeProvider } from "../../platform/context"
import { createFakeDesktop } from "../../test/fake-desktop"
import { GeneralSettings } from "./general-settings"
import { I18nProvider } from "../../i18n/i18n-context"

function renderGeneral() {
  const desktop = createFakeDesktop()
  render(() => (
    <DesktopBridgeProvider bridge={desktop.bridge}>
      <I18nProvider>
        <GeneralSettings />
      </I18nProvider>
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
      expect(desktop.bridge.saveSettings).toHaveBeenCalledWith(expect.objectContaining({ startup: "home", theme: "dark" })),
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

  it("persists language changes and updates the interface immediately", async () => {
    const desktop = renderGeneral()
    const user = userEvent.setup()

    await user.selectOptions(await screen.findByRole("combobox", { name: "语言" }), "en-US")

    await waitFor(() => expect(desktop.settings().locale).toBe("en-US"))
    expect(screen.getByRole("combobox", { name: "Language" })).toHaveValue("en-US")
    expect(screen.getByRole("heading", { name: "Appearance" })).toBeVisible()
  })

  it("rolls language back when persistence fails", async () => {
    const desktop = renderGeneral()
    await screen.findByRole("combobox", { name: "语言" })
    vi.mocked(desktop.bridge.saveSettings).mockRejectedValueOnce(new Error("store unavailable"))

    await userEvent.setup().selectOptions(screen.getByRole("combobox", { name: "语言" }), "en-US")

    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent("store unavailable"))
    expect(screen.getByRole("combobox", { name: "语言" })).toHaveValue("zh-CN")
  })

  it("keeps later-phase controls disabled and coming soon", async () => {
    renderGeneral()

    expect(await screen.findByRole("combobox", { name: "语言" })).toBeEnabled()
    expect(screen.getByLabelText("Apple 风格液态玻璃")).toBeDisabled()
    for (const label of ["回复完成", "等待权限", "Agent 提问"]) {
      expect(screen.getByLabelText(label)).toBeDisabled()
    }
    expect(screen.getAllByText("即将推出").length).toBeGreaterThanOrEqual(2)
  })
})
