import { cleanup, render, screen } from "@solidjs/testing-library"
import userEvent from "@testing-library/user-event"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { App } from "../app"
import { defaultDesktopSettings, type AppLocale } from "../features/settings/settings-preferences"
import { createFakeDesktop } from "../test/fake-desktop"
import { createFakeJyycode } from "../test/fake-jyycode"

function renderDesktop(locale: AppLocale) {
  const desktop = createFakeDesktop({ settings: { ...defaultDesktopSettings, locale } })
  const backend = createFakeJyycode(desktop.directory)
  vi.stubGlobal("fetch", backend.fetch)
  render(() => <App bridge={desktop.bridge} />)
  return desktop
}

describe("localized desktop routes", () => {
  beforeEach(() => {
    Object.defineProperty(window, "scrollTo", { configurable: true, value: vi.fn() })
    Object.defineProperty(window, "requestAnimationFrame", {
      configurable: true,
      value: (callback: FrameRequestCallback) => window.setTimeout(() => callback(performance.now()), 0),
    })
    window.history.replaceState(null, "", "/")
  })

  afterEach(() => {
    cleanup()
    vi.unstubAllGlobals()
  })

  it.each([
    ["zh-CN", "全局管理", "打开目录", "新建项目"],
    ["en-US", "Global management", "Open directory", "New project"],
  ] as const)("renders Home in %s", async (locale, navigation, open, create) => {
    renderDesktop(locale)

    expect(await screen.findByRole("navigation", { name: navigation })).toBeVisible()
    expect(screen.getByRole("button", { name: open })).toBeVisible()
    expect(screen.getByRole("button", { name: create })).toBeVisible()
  })

  it("keeps management, Settings, and workspace routes consistently English", async () => {
    const user = userEvent.setup()
    renderDesktop("en-US")

    await user.click(await screen.findByRole("link", { name: "Skill" }))
    expect(await screen.findByRole("heading", { name: "Skill" })).toBeVisible()
    expect(screen.getByRole("searchbox", { name: "Search Skill" })).toBeVisible()

    await user.click(screen.getByRole("link", { name: "MCP" }))
    expect(await screen.findByRole("heading", { name: "MCP" })).toBeVisible()
    expect(screen.getByText("Manage the global Model Context Protocol server.")).toBeVisible()

    await user.click(screen.getByRole("link", { name: "Settings" }))
    expect(await screen.findByRole("heading", { name: "Settings" })).toBeVisible()
    expect(screen.getByRole("combobox", { name: "Language" })).toHaveValue("en-US")

    await user.click(screen.getByRole("link", { name: "Advanced" }))
    expect(await screen.findByRole("heading", { name: "Advanced" })).toBeVisible()

    await user.click(screen.getByRole("button", { name: "Return" }))
    await user.click(await screen.findByRole("button", { name: "Open directory" }))
    expect(
      await screen.findByRole("complementary", { name: "Project and Session Navigation" }, { timeout: 10_000 }),
    ).toBeVisible()
  }, 15_000)
})
