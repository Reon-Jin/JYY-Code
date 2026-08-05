import { cleanup, render, screen, waitFor } from "@solidjs/testing-library"
import userEvent from "@testing-library/user-event"
import { afterEach, describe, expect, it, vi } from "vitest"
import { DesktopBridgeProvider } from "../../platform/context"
import { createFakeDesktop } from "../../test/fake-desktop"
import { GeneralSettings } from "./general-settings"
import { I18nProvider } from "../../i18n/i18n-context"
import * as soundEffects from "../sound-effects/sound-effects"

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
  })

  it("persists startup preferences", async () => {
    const desktop = renderGeneral()
    const user = userEvent.setup()

    await user.click(await screen.findByRole("radio", { name: "启动时显示 Home" }))
    await waitFor(() =>
      expect(desktop.bridge.saveSettings).toHaveBeenCalledWith(expect.objectContaining({ startup: "home" })),
    )
    await waitFor(() => expect(desktop.settings().startup).toBe("home"))
  })

  it("rolls back the startup preference when persistence fails", async () => {
    const desktop = renderGeneral()
    vi.mocked(desktop.bridge.saveSettings).mockRejectedValueOnce(new Error("store unavailable"))

    await userEvent.setup().click(await screen.findByRole("radio", { name: "启动时显示 Home" }))

    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent("store unavailable"))
    expect(screen.getByRole("radio", { name: "恢复上次项目" })).toBeChecked()
  })

  it("persists language changes and updates the interface immediately", async () => {
    const desktop = renderGeneral()
    const user = userEvent.setup()

    await user.selectOptions(await screen.findByRole("combobox", { name: "语言" }), "en-US")

    await waitFor(() => expect(desktop.settings().locale).toBe("en-US"))
    expect(screen.getByRole("combobox", { name: "Language" })).toHaveValue("en-US")
    expect(screen.getByRole("heading", { name: "System notifications" })).toBeVisible()
  })

  it("rolls language back when persistence fails", async () => {
    const desktop = renderGeneral()
    await screen.findByRole("combobox", { name: "语言" })
    vi.mocked(desktop.bridge.saveSettings).mockRejectedValueOnce(new Error("store unavailable"))

    await userEvent.setup().selectOptions(screen.getByRole("combobox", { name: "语言" }), "en-US")

    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent("store unavailable"))
    expect(screen.getByRole("combobox", { name: "语言" })).toHaveValue("zh-CN")
  })

  it("exposes notification controls", async () => {
    renderGeneral()

    expect(await screen.findByRole("combobox", { name: "语言" })).toBeEnabled()
    for (const label of ["回复完成", "等待权限", "Agent 提问"]) {
      expect(screen.getByLabelText(label)).toBeEnabled()
    }
    expect(screen.getByRole("heading", { name: "系统通知" })).toBeVisible()
    expect(screen.queryByText("即将推出")).not.toBeInTheDocument()
  })

  it("requests permission only when enabling and keeps the choice after denial", async () => {
    const desktop = createFakeDesktop()
    vi.mocked(desktop.bridge.getNotificationPermission!).mockResolvedValue("default")
    vi.mocked(desktop.bridge.requestNotificationPermission).mockResolvedValue("denied")
    render(() => (
      <DesktopBridgeProvider bridge={desktop.bridge}>
        <I18nProvider>
          <GeneralSettings />
        </I18nProvider>
      </DesktopBridgeProvider>
    ))
    const user = userEvent.setup()
    const completion = await screen.findByRole("checkbox", { name: "回复完成" })

    await user.click(completion)
    await waitFor(() => expect(desktop.settings().notifications.completion).toBe(false))
    expect(desktop.bridge.requestNotificationPermission).not.toHaveBeenCalled()

    await user.click(completion)
    await waitFor(() => expect(desktop.settings().notifications.completion).toBe(true))
    expect(desktop.bridge.requestNotificationPermission).toHaveBeenCalledOnce()
    expect(screen.getByRole("status")).toHaveTextContent("已拒绝")
  })

  it("persists the sound effects preference and notifies the sound system", async () => {
    const desktop = renderGeneral()
    const publish = vi.spyOn(soundEffects, "publishSoundEffectsEnabled")
    const toggle = await screen.findByRole("switch", { name: "开启声音效果" })

    expect(toggle).toBeChecked()
    await userEvent.setup().click(toggle)

    await waitFor(() => expect(desktop.settings().soundEffects).toBe(false))
    expect(desktop.bridge.saveSettings).toHaveBeenCalledWith(expect.objectContaining({ soundEffects: false }))
    expect(publish).toHaveBeenCalledWith(false)
  })
})
