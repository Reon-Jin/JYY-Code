import { cleanup, render, screen, waitFor } from "@solidjs/testing-library"
import userEvent from "@testing-library/user-event"
import { readFileSync } from "node:fs"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { App } from "./app"
import { createFakeDesktop } from "./test/fake-desktop"
import { createFakeJyycode } from "./test/fake-jyycode"

function unnamedIconButtons(root: ParentNode) {
  return [...root.querySelectorAll<HTMLButtonElement>("button")].filter((button) => {
    const name = button.getAttribute("aria-label") ?? button.textContent ?? ""
    return !name.trim()
  })
}

describe("desktop accessibility contract", () => {
  beforeEach(() => {
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
    window.history.replaceState(null, "", "/")
  })

  afterEach(() => {
    cleanup()
    vi.unstubAllGlobals()
  })

  it("keeps landmarks, controls, focus, alerts, and live status accessible", async () => {
    const user = userEvent.setup()
    const desktop = createFakeDesktop()
    const backend = createFakeJyycode(desktop.directory)
    vi.stubGlobal("fetch", backend.fetch)
    const { container } = render(() => <App bridge={desktop.bridge} />)

    expect(await screen.findAllByRole("main")).toHaveLength(1)
    expect(unnamedIconButtons(container)).toEqual([])
    const trigger = screen.getByRole("button", { name: /新建项目/ })
    trigger.focus()
    await user.keyboard("{Enter}")
    expect(screen.getByRole("dialog", { name: "新建项目" })).toBeVisible()
    const dialog = screen.getByRole("dialog", { name: "新建项目" })
    dialog.dispatchEvent(new Event("cancel", { cancelable: true }))
    await waitFor(() => expect(trigger).toHaveFocus())

    await user.keyboard("{Enter}")
    const submit = screen.getByRole("button", { name: "创建并进入" })
    submit.focus()
    await user.keyboard("{Enter}")
    expect(await screen.findByRole("alert")).toHaveTextContent("请选择父目录")
    expect(screen.getByRole("textbox", { name: "父目录" })).toHaveFocus()
  })

  it("labels the project, Session, Agent, model, and Composer controls after restore", async () => {
    const desktop = createFakeDesktop({
      lastLocation: { project: "C:\\work\\demo", sessionID: "ses_1" },
    })
    const backend = createFakeJyycode(desktop.directory)
    backend.sessions.push({
      id: "ses_1",
      slug: "session-1",
      projectID: backend.project.id,
      directory: desktop.directory,
      title: "New session",
      version: "test",
      time: { created: 1, updated: 1 },
    })
    backend.messages.set("ses_1", [])
    vi.stubGlobal("fetch", backend.fetch)
    const { container } = render(() => <App bridge={desktop.bridge} />)

    expect(await screen.findAllByRole("main")).toHaveLength(1)
    expect(screen.getByRole("complementary", { name: "项目与 Session 导航" })).toBeVisible()
    expect(screen.getByRole("navigation", { name: "活动 Session" })).toBeVisible()
    expect(screen.getByRole("combobox", { name: "Agent" })).toBeVisible()
    expect(screen.getByRole("combobox", { name: "模型" })).toBeVisible()
    expect(screen.getByRole("region", { name: "消息编辑器" })).toBeVisible()
    expect(screen.getByRole("textbox", { name: "消息" })).toBeVisible()
    expect(container.querySelector(".workspace-connection")).toHaveAttribute("aria-live", "polite")
    expect(unnamedIconButtons(container)).toEqual([])
  })

  it("defines a reduced-motion override for nonessential transitions", () => {
    const stylesheet = readFileSync("src/styles/global.css", "utf8")
    expect(stylesheet).toMatch(/prefers-reduced-motion:\s*reduce/)
    expect(stylesheet).toMatch(/transition-duration:\s*0\.01ms/)
  })
})
