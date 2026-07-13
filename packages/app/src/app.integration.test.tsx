import { cleanup, fireEvent, render, screen, waitFor } from "@solidjs/testing-library"
import userEvent from "@testing-library/user-event"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { App } from "./app"
import { createFakeDesktop } from "./test/fake-desktop"
import { createFakeJyycode } from "./test/fake-jyycode"

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

describe("desktop GUI journey", () => {
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

  it("creates, prompts, streams, answers, stops, and restores a single-Agent Session", async () => {
    const user = userEvent.setup()
    const desktop = createFakeDesktop()
    const backend = createFakeJyycode(desktop.directory)
    vi.stubGlobal("fetch", backend.fetch)

    render(() => <App bridge={desktop.bridge} />)
    const createProject = await screen.findByRole("button", { name: /新建项目/ })
    createProject.focus()
    await user.keyboard("{Enter}")
    const chooseParent = screen.getByRole("button", { name: "选择" })
    chooseParent.focus()
    await user.keyboard("{Enter}")
    await user.type(screen.getByRole("textbox", { name: "项目名称" }), "demo")
    const submitProject = screen.getByRole("button", { name: "创建并进入" })
    submitProject.focus()
    await user.keyboard("{Enter}")

    expect(await screen.findByRole("main")).toBeVisible()
    expect(await screen.findByRole("combobox", { name: "Agent" })).toHaveValue("build")
    expect(screen.getByRole("combobox", { name: "模型" })).toHaveValue("test/test-model")
    expect(screen.queryByText(/Multi-Agent/i)).not.toBeInTheDocument()
    expect(backend.requests.find((request) => request.method === "POST" && request.path === "/session")?.body)
      .toMatchObject({ multiAgent: false })

    const composer = screen.getByRole("textbox", { name: "消息" })
    await user.type(composer, "检查当前工作区")
    fireEvent.keyDown(composer, { key: "Enter", code: "Enter" })

    expect(await screen.findByText("流式回复已完成")).toBeVisible()
    expect(screen.getByRole("region", { name: "工具调用：bash" })).toHaveTextContent("检查工作区")
    const handleRequest = await screen.findByRole("button", { name: "处理请求" })
    handleRequest.focus()
    await user.keyboard("{Enter}")
    const allowOnce = screen.getByRole("button", { name: "仅本次允许" })
    expect(allowOnce).toHaveFocus()
    await user.keyboard("{Enter}")
    await waitFor(() => expect(backend.permissions).toHaveLength(0))

    const stop = screen.getByRole("button", { name: "停止" })
    stop.focus()
    await user.keyboard("{Enter}")
    await waitFor(() => expect(screen.getByRole("button", { name: "发送" })).toBeVisible())
    expect(desktop.lastLocation()).toEqual({ project: desktop.directory, sessionID: "ses_1" })

    cleanup()
    window.history.replaceState(null, "", "/")
    render(() => <App bridge={desktop.bridge} />)

    expect(await screen.findByText("流式回复已完成")).toBeVisible()
    expect(screen.getByText("检查当前工作区")).toBeVisible()
    expect(screen.queryByText(/Multi-Agent/i)).not.toBeInTheDocument()
  })
})
