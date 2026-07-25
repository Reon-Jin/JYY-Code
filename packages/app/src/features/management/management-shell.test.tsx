import { createMemoryHistory, MemoryRouter, Route } from "@solidjs/router"
import { cleanup, render, screen } from "@solidjs/testing-library"
import userEvent from "@testing-library/user-event"
import { afterEach, describe, expect, it, vi } from "vitest"
import { ManagementShell } from "./management-shell"

function renderShell(path = "/") {
  const history = createMemoryHistory()
  history.set({ value: path, replace: true, scroll: false })
  const project = {
    openProject: vi.fn(),
    returnToProjectSelection: vi.fn(),
  }
  render(() => (
    <MemoryRouter history={history}>
      <Route
        path="/*all"
        component={() => (
          <ManagementShell>
            <main data-testid="management-content">content</main>
          </ManagementShell>
        )}
      />
    </MemoryRouter>
  ))
  return { history, project }
}

describe("ManagementShell", () => {
  afterEach(cleanup)

  it.each([
    ["/", "首页"],
    ["/skills", "Skill"],
    ["/mcp", "MCP"],
  ])("marks %s as the current management route", (path, label) => {
    renderShell(path)

    const navigation = screen.getByRole("navigation", { name: "全局管理" })
    expect(navigation).toBeVisible()
    expect(screen.getByRole("link", { name: label })).toHaveAttribute("aria-current", "page")
  })

  it("uses keyboard-operable links without changing project state", async () => {
    const user = userEvent.setup()
    const { project } = renderShell()

    const skills = screen.getByRole("link", { name: "Skill" })
    skills.focus()
    await user.keyboard("{Enter}")

    expect(skills).toHaveAttribute("href", "/skills")
    expect(screen.getByRole("link", { name: "Skill" })).toHaveAttribute("aria-current", "page")
    expect(project.openProject).not.toHaveBeenCalled()
    expect(project.returnToProjectSelection).not.toHaveBeenCalled()
  })

  it("places a Settings entry at the bottom of the rail", () => {
    renderShell()

    expect(screen.getByRole("link", { name: "设置" })).toHaveAttribute("href", "/settings/general?returnTo=%2F")
  })
})
