// @ts-nocheck
import { cleanup, render, screen, waitFor } from "@solidjs/testing-library"
import userEvent from "@testing-library/user-event"
import { readFileSync } from "node:fs"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { App } from "./app"
import { createFakeDesktop } from "./test/fake-desktop"
import { createFakeJyycode } from "./test/fake-jyycode"

const copy = {
  navigation: "\u9879\u76ee\u4e0e\u4f1a\u8bdd\u5bfc\u822a",
  activeSessions: "\u6d3b\u52a8\u4f1a\u8bdd",
  workbench: "\u4f1a\u8bdd\u5de5\u4f5c\u533a\u9875\u9762",
  controls: "\u4efb\u52a1\u63a7\u5236\u4e0e\u8f93\u5165",
  composer: "\u6d88\u606f\u7f16\u8f91\u5668",
  message: "\u6d88\u606f",
  agent: "\u667a\u80fd\u4f53",
  agents: "\u591a\u667a\u80fd\u4f53",
  plan: "\u65b9\u6848",
  collapse: "\u6536\u8d77",
}

function unnamedIconButtons(root: ParentNode) {
  return [...root.querySelectorAll<HTMLButtonElement>("button")].filter((button) => {
    const name = button.getAttribute("aria-label") ?? button.textContent ?? ""
    return !name.trim()
  })
}

function restoreWorkspace(input: { multiAgent?: boolean } = {}) {
  const desktop = createFakeDesktop({ lastLocation: { project: "C:\\work\\demo", sessionID: "ses_root" } })
  const backend = createFakeJyycode(desktop.directory)
  backend.addSession({ id: "ses_root", slug: "root", title: "Root Session", multiAgent: input.multiAgent })
  return { desktop, backend }
}

describe("desktop accessibility contract", () => {
  beforeEach(() => {
    Object.defineProperty(window, "scrollTo", { configurable: true, value: vi.fn() })
    Object.defineProperty(window, "requestAnimationFrame", {
      configurable: true,
      value: (callback: FrameRequestCallback) => window.setTimeout(() => callback(performance.now()), 0),
    })
    Object.defineProperties(HTMLDialogElement.prototype, {
      close: { configurable: true, value(this: HTMLDialogElement) { this.removeAttribute("open") } },
      showModal: { configurable: true, value(this: HTMLDialogElement) { this.setAttribute("open", "") } },
    })
    window.history.replaceState(null, "", "/")
    localStorage.clear()
  })

  afterEach(() => {
    cleanup()
    vi.unstubAllGlobals()
  })

  it("keeps the project landing landmarks and controls named", async () => {
    const desktop = createFakeDesktop()
    const backend = createFakeJyycode(desktop.directory)
    vi.stubGlobal("fetch", backend.fetch)
    const { container } = render(() => <App bridge={desktop.bridge} />)

    expect(await screen.findAllByRole("main", {}, { timeout: 5_000 })).toHaveLength(1)
    expect(await screen.findByRole("navigation", {}, { timeout: 5_000 })).toBeVisible()
    expect(unnamedIconButtons(container)).toEqual([])
  })

  it("exposes the new workbench, central controls, and chat as named landmarks", async () => {
    const { desktop, backend } = restoreWorkspace()
    vi.stubGlobal("fetch", backend.fetch)
    const { container } = render(() => <App bridge={desktop.bridge} />)

    expect(await screen.findByRole("complementary", { name: copy.navigation }, { timeout: 5_000 })).toBeVisible()
    await screen.findByRole("heading", { name: "Root Session" }, { timeout: 5_000 })
    expect(screen.getByRole("navigation", { name: copy.activeSessions })).toBeVisible()
    expect(screen.getByRole("region", { name: copy.workbench })).toBeVisible()
    expect(screen.getByRole("region", { name: copy.controls })).toBeVisible()
    expect(screen.getByRole("region", { name: copy.composer })).toBeVisible()
    expect(screen.getByRole("textbox", { name: copy.message })).toBeVisible()
    expect(await screen.findByRole("combobox", { name: copy.agent })).toBeVisible()
    expect(screen.getAllByRole("button", { name: /\u70b9\u51fb\u5c55\u5f00/ })).toHaveLength(7)
    expect(container.querySelector(".workspace-inspector")).not.toBeInTheDocument()
    expect(container.querySelector(".branch-control__trigger")).toHaveAttribute("aria-haspopup", "dialog")
    expect(unnamedIconButtons(container)).toEqual([])
  })

  it("opens a workbench card and exposes the active multi-agent switch to keyboard users", async () => {
    const user = userEvent.setup()
    const { desktop, backend } = restoreWorkspace({ multiAgent: true })
    vi.stubGlobal("fetch", backend.fetch)
    render(() => <App bridge={desktop.bridge} />)

    const mode = await screen.findByRole("switch", { name: copy.agents }, { timeout: 5_000 })
    mode.focus()
    expect(mode).toHaveFocus()
    expect(mode).toHaveAttribute("aria-checked", "true")

    const plan = screen.getByRole("button", { name: "编辑方案详细信息" })
    plan.focus()
    await user.keyboard("{Enter}")
    expect(screen.getByRole("region", { name: copy.plan })).toBeVisible()
    const close = screen.getByRole("button", { name: copy.collapse })
    close.focus()
    await user.keyboard("{Enter}")
    await waitFor(() => expect(document.querySelector(".workbench-module-detail")).not.toBeInTheDocument())
  })

  it("defines a reduced-motion override for nonessential transitions", () => {
    const stylesheet = readFileSync("src/styles/global.css", "utf8")
    expect(stylesheet).toMatch(/prefers-reduced-motion:\s*reduce/)
    expect(stylesheet).toMatch(/transition-duration:\s*0\.01ms/)
  })
})
