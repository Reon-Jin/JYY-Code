import { createMemoryHistory, MemoryRouter, Route } from "@solidjs/router"
import { cleanup, render, screen } from "@solidjs/testing-library"
import userEvent from "@testing-library/user-event"
import { afterEach, describe, expect, it } from "vitest"
import { SettingsPage } from "./settings-page"
import { DesktopBridgeProvider } from "../../platform/context"
import { createFakeDesktop } from "../../test/fake-desktop"

function SettingsTestPage() {
  return (
    <DesktopBridgeProvider bridge={createFakeDesktop().bridge}>
      <SettingsPage />
    </DesktopBridgeProvider>
  )
}

describe("SettingsPage", () => {
  afterEach(cleanup)

  it("renders as a standalone page and returns only to the sanitized route", async () => {
    const history = createMemoryHistory()
    history.set({ value: "/settings/general?returnTo=%2Fsession%2Fses_1", replace: true, scroll: false })
    render(() => (
      <MemoryRouter history={history}>
        <Route path="/settings/:section" component={SettingsTestPage} />
        <Route path="/session/:sessionID" component={() => <h1>Restored Session</h1>} />
      </MemoryRouter>
    ))

    expect(screen.getByRole("heading", { name: "设置" })).toBeVisible()
    expect(screen.queryByRole("navigation", { name: "全局管理" })).not.toBeInTheDocument()
    expect(screen.getByRole("navigation", { name: "设置分类" })).toBeVisible()

    await userEvent.setup().click(screen.getByRole("button", { name: "返回" }))
    expect(await screen.findByRole("heading", { name: "Restored Session" })).toBeVisible()
  })

  it("preserves returnTo while switching sections", () => {
    const history = createMemoryHistory()
    history.set({ value: "/settings/general?returnTo=%2Fworkspace", replace: true, scroll: false })
    render(() => (
      <MemoryRouter history={history}>
        <Route path="/settings/:section" component={SettingsTestPage} />
      </MemoryRouter>
    ))

    expect(screen.getByRole("link", { name: "权限与安全" })).toHaveAttribute(
      "href",
      "/settings/security?returnTo=%2Fworkspace",
    )
  })
})
