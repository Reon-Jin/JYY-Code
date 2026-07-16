import { cleanup, render, screen, waitFor } from "@solidjs/testing-library"
import userEvent from "@testing-library/user-event"
import { afterEach, describe, expect, it, vi } from "vitest"
import { DesktopBridgeProvider } from "../platform/context"
import { createFakeDesktop } from "../test/fake-desktop"
import { defaultDesktopSettings } from "../features/settings/settings-preferences"
import { I18nProvider, useI18n } from "./i18n-context"

function Harness() {
  const i18n = useI18n()
  return (
    <div>
      <output data-testid="locale">{i18n.locale()}</output>
      <output data-testid="ready">{String(i18n.isReady())}</output>
      <output data-testid="message">{i18n.t("settings.general.title")}</output>
      <button onClick={() => void i18n.setLocale("en-US").catch(() => undefined)}>English</button>
    </div>
  )
}

function mount(input?: Parameters<typeof createFakeDesktop>[0]) {
  const desktop = createFakeDesktop(input)
  render(() => (
    <DesktopBridgeProvider bridge={desktop.bridge}>
      <I18nProvider>
        <Harness />
      </I18nProvider>
    </DesktopBridgeProvider>
  ))
  return desktop
}

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

describe("I18nProvider", () => {
  it("starts from Chinese and becomes ready after loading settings", async () => {
    mount()

    expect(screen.getByRole("status")).toHaveTextContent("正在启动 JYYCode")
    expect(await screen.findByTestId("locale")).toHaveTextContent("zh-CN")
    expect(screen.getByTestId("message")).toHaveTextContent("通用设置")
    await waitFor(() => expect(screen.getByTestId("ready")).toHaveTextContent("true"))
    expect(document.documentElement).toHaveAttribute("lang", "zh-CN")
    expect(document.documentElement).toHaveAttribute("data-locale", "zh-CN")
  })

  it("restores English from persisted settings", async () => {
    mount({ settings: { ...defaultDesktopSettings, locale: "en-US" } })

    await waitFor(() => expect(screen.getByTestId("locale")).toHaveTextContent("en-US"))
    expect(screen.getByTestId("message")).toHaveTextContent("General settings")
    expect(document.documentElement).toHaveAttribute("lang", "en-US")
    expect(document.documentElement).toHaveAttribute("data-locale", "en-US")
  })

  it("persists locale changes", async () => {
    const user = userEvent.setup()
    const desktop = mount()
    await waitFor(() => expect(screen.getByTestId("ready")).toHaveTextContent("true"))

    await user.click(screen.getByRole("button", { name: "English" }))

    await waitFor(() => expect(desktop.settings().locale).toBe("en-US"))
    expect(screen.getByTestId("message")).toHaveTextContent("General settings")
  })

  it("rolls back locale and document attributes when persistence fails", async () => {
    const user = userEvent.setup()
    const desktop = mount()
    await waitFor(() => expect(screen.getByTestId("ready")).toHaveTextContent("true"))
    vi.mocked(desktop.bridge.saveSettings).mockRejectedValueOnce(new Error("store unavailable"))

    await user.click(screen.getByRole("button", { name: "English" }))

    await waitFor(() => expect(screen.getByTestId("locale")).toHaveTextContent("zh-CN"))
    expect(document.documentElement).toHaveAttribute("lang", "zh-CN")
    expect(document.documentElement).toHaveAttribute("data-locale", "zh-CN")
  })
})
