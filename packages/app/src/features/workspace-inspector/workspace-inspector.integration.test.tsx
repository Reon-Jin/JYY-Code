import { cleanup, render, screen, waitFor, within } from "@solidjs/testing-library"
import userEvent from "@testing-library/user-event"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { App } from "../../app"
import { createFakeDesktop } from "../../test/fake-desktop"
import { createFakeJyycode } from "../../test/fake-jyycode"

function installDialog() {
  Object.defineProperties(HTMLDialogElement.prototype, {
    close: {
      configurable: true,
      value(this: HTMLDialogElement) {
        this.removeAttribute("open")
        this.dispatchEvent(new Event("close"))
      },
    },
    showModal: {
      configurable: true,
      value(this: HTMLDialogElement) {
        this.setAttribute("open", "")
      },
    },
  })
}

function restoredWorkspace() {
  const desktop = createFakeDesktop({ lastLocation: { project: "C:\\work\\demo", sessionID: "ses_1" } })
  const backend = createFakeJyycode(desktop.directory)
  backend.sessions.push({
    id: "ses_1",
    slug: "session-1",
    projectID: backend.project.id,
    directory: desktop.directory,
    title: "Workspace flow",
    version: "test",
    time: { created: 1, updated: 1 },
  })
  backend.messages.set("ses_1", [])
  return { desktop, backend }
}

beforeEach(() => {
  installDialog()
  Object.defineProperty(window, "scrollTo", { configurable: true, value: vi.fn() })
  Object.defineProperty(window, "requestAnimationFrame", {
    configurable: true,
    value: (callback: FrameRequestCallback) => window.setTimeout(() => callback(performance.now()), 0),
  })
  window.history.replaceState(null, "", "/")
  localStorage.clear()
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

describe("central workbench integration", () => {
  it("keeps the former inspector controls in the workbench and switches an unstarted workflow", async () => {
    const user = userEvent.setup()
    const { desktop, backend } = restoredWorkspace()
    backend.setTodos("ses_1", [{ content: "Inspect workspace", status: "pending", priority: "high" }])
    vi.stubGlobal("fetch", backend.fetch)
    render(() => <App bridge={desktop.bridge} />)

    await waitFor(() => expect(screen.getByRole("heading", { name: "Workspace flow" })).toBeVisible(), {
      timeout: 5_000,
    })
    expect(document.querySelector(".workspace-inspector")).not.toBeInTheDocument()
    expect(document.querySelectorAll(".workbench-module-card")).toHaveLength(7)

    await user.click(screen.getByRole("button", { name: "编辑方案详细信息" }))
    expect(screen.getByRole("region", { name: "方案" })).toBeVisible()
    await user.click(screen.getByRole("button", { name: "收起" }))
    expect(document.querySelector(".workbench-module-detail")).not.toBeInTheDocument()

    const controlShelf = screen.getByRole("region", { name: "任务控制与输入" })
    expect(within(controlShelf).getByRole("combobox", { name: "智能体" })).toBeVisible()
    expect(within(controlShelf).getByRole("button", { name: /版本库|main/ })).toBeVisible()

    const picker = document.querySelector<HTMLDetailsElement>(".workflow-picker")
    expect(picker).toBeTruthy()
    await user.click(picker!.querySelector("summary")!)
    const creationWorkflow = screen.getByRole("menuitemradio", { name: /创建工作流/ })
    await user.click(creationWorkflow)
    await waitFor(() => expect(creationWorkflow).toHaveAttribute("aria-checked", "true"))
    expect(picker).toHaveTextContent("创建工作流")
  })

  it("keeps chat editable when GitHub CLI is unavailable", async () => {
    const user = userEvent.setup()
    const { desktop, backend } = restoredWorkspace()
    backend.setGitHubStatus({ available: false, reason: "missing-gh", message: "gh executable was not found" })
    vi.stubGlobal("fetch", backend.fetch)
    render(() => <App bridge={desktop.bridge} />)
    const composer = await screen.findByRole("textbox", { name: "消息" }, { timeout: 5_000 })
    await user.type(composer, "chat remains available")
    expect(composer).toHaveValue("chat remains available")
    expect(screen.getByLabelText("对话")).toContainElement(composer)
    expect(screen.getByLabelText("对话")).toBeVisible()
  })
})
