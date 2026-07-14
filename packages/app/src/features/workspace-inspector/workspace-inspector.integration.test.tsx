import { cleanup, fireEvent, render, screen, waitFor, within } from "@solidjs/testing-library"
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

describe("workspace inspector Git and GitHub journey", () => {
  it("moves from live Todo and Changes through branch sync and the PR lifecycle", async () => {
    const user = userEvent.setup()
    const { desktop, backend } = restoredWorkspace()
    backend.setTodos("ses_1", [{ content: "Inspect workspace", status: "pending", priority: "high" }])
    vi.stubGlobal("fetch", backend.fetch)
    render(() => <App bridge={desktop.bridge} />)

    await waitFor(() => expect(screen.getByRole("heading", { name: "Workspace flow" })).toBeVisible(), {
      timeout: 5_000,
    })
    expect(await screen.findByText("Inspect workspace")).toBeVisible()
    expect(await screen.findByText("后端已连接")).toBeVisible()
    expect(screen.getByText("Inspect workspace").closest("li")).toHaveTextContent("未开始")

    expect(await screen.findByRole("button", { name: /src\/app.tsx, \+4 -1/ })).toBeVisible()
    const separator = screen.getByRole("separator", { name: "调整计划与工作区变更高度" })
    separator.focus()
    await user.keyboard("{End}")
    expect(separator).toHaveAttribute("aria-valuenow", "80")
    await user.click(screen.getByRole("button", { name: "收起工作栏" }))
    await user.click(screen.getByRole("button", { name: "展开工作栏" }))
    expect(screen.getByRole("separator")).toHaveAttribute("aria-valuenow", "80")

    await user.click(await screen.findByRole("button", { name: /main/ }))
    const branchDialog = screen.getByRole("dialog", { name: "Git 分支" })
    await user.type(within(branchDialog).getByLabelText("新分支名称"), "feature/integration")
    await user.click(within(branchDialog).getByRole("button", { name: "新建分支" }))
    await waitFor(() => expect(within(branchDialog).getByRole("status")).toHaveTextContent("feature/integration"))
    await user.click(within(branchDialog).getByRole("button", { name: "Fetch" }))
    await waitFor(() => expect(within(branchDialog).getByRole("status")).toHaveTextContent("Fetch 完成"))
    await user.click(within(branchDialog).getByRole("button", { name: "Push" }))
    await waitFor(() => expect(within(branchDialog).getByRole("status")).toHaveTextContent("Push 完成"))
    const loadingFlashes: string[] = []
    const observer = new MutationObserver(() => {
      if (document.body.textContent?.includes("正在加载工作区")) loadingFlashes.push("workspace")
    })
    observer.observe(document.body, { childList: true, subtree: true })
    await user.click(within(branchDialog).getByRole("button", { name: "Pull Requests" }))

    const pullDialog = await screen.findByRole("dialog", { name: "GitHub Pull Requests" })
    observer.disconnect()
    expect(loadingFlashes).toEqual([])
    expect(within(pullDialog).getByText("example/demo")).toBeVisible()
    await user.click(within(pullDialog).getByRole("button", { name: "创建 Pull Request" }))
    const createForm = within(pullDialog).getByRole("form", { name: "创建 Pull Request" })
    await user.type(within(createForm).getByLabelText("标题"), "Integration draft")
    await user.clear(within(createForm).getByLabelText("Head"))
    await user.type(within(createForm).getByLabelText("Head"), "feature/integration")
    await user.click(within(createForm).getByLabelText("创建为 Draft"))
    await user.click(within(createForm).getByRole("button", { name: "创建" }))
    expect(await within(pullDialog).findByRole("heading", { name: "Integration draft" })).toBeVisible()

    await user.click(within(pullDialog).getByRole("button", { name: "编辑" }))
    const editForm = within(pullDialog).getByRole("form", { name: "编辑 Pull Request" })
    await user.clear(within(editForm).getByLabelText("标题"))
    await user.type(within(editForm).getByLabelText("标题"), "Integration draft updated")
    await user.click(within(editForm).getByRole("button", { name: "保存" }))
    expect(await within(pullDialog).findByRole("heading", { name: "Integration draft updated" })).toBeVisible()

    await user.type(within(pullDialog).getByLabelText("添加评论"), "Desktop integration comment")
    await user.click(within(pullDialog).getByRole("button", { name: "评论" }))
    await waitFor(() => expect(within(pullDialog).getByRole("status")).toHaveTextContent("评论已发布"))
    await user.click(within(pullDialog).getByRole("button", { name: "Diff" }))
    expect(await within(pullDialog).findByLabelText("Pull Request unified diff")).toHaveTextContent("+new")
    await user.click(within(pullDialog).getByRole("button", { name: "Overview" }))
    await user.click(within(pullDialog).getByRole("button", { name: /Checkout feature\/integration/ }))
    await waitFor(() => expect(within(pullDialog).getByRole("status")).toHaveTextContent("已 Checkout"))
    await user.click(within(pullDialog).getByRole("button", { name: "Close" }))
    await user.click(within(pullDialog).getByRole("button", { name: "Closed" }))
    await user.click(await within(pullDialog).findByRole("button", { name: /#2 Integration draft updated/ }))
    expect(await within(pullDialog).findByRole("button", { name: "Reopen" })).toBeVisible()
    await user.click(within(pullDialog).getByRole("button", { name: "Reopen" }))

    await user.click(within(pullDialog).getByRole("button", { name: "Open" }))
    await user.click(within(pullDialog).getByRole("button", { name: /#1 Workspace inspector/ }))
    expect(await within(pullDialog).findByRole("button", { name: "Merge" })).toBeEnabled()
    await user.click(within(pullDialog).getByRole("button", { name: "Merge" }))
    const mergeDialog = screen.getByRole("dialog", { name: "合并 #1" })
    expect(within(mergeDialog).getByLabelText("Squash")).toBeChecked()
    await user.click(within(mergeDialog).getByRole("button", { name: "确认合并" }))
    await waitFor(() => expect(mergeDialog).not.toHaveAttribute("open"))
    await user.click(within(pullDialog).getByRole("button", { name: "All" }))
    await user.click(await within(pullDialog).findByRole("button", { name: /#1 Workspace inspector/ }))
    await waitFor(() => expect(within(pullDialog).getByText(/#1 · MERGED/)).toBeVisible())
  }, 30_000)

  it("keeps chat editable when GitHub CLI is unavailable", async () => {
    const user = userEvent.setup()
    const { desktop, backend } = restoredWorkspace()
    backend.setGitHubStatus({ available: false, reason: "missing-gh", message: "gh executable was not found" })
    vi.stubGlobal("fetch", backend.fetch)
    render(() => <App bridge={desktop.bridge} />)
    const composer = await screen.findByRole("textbox", { name: "消息" }, { timeout: 5_000 })
    await user.type(composer, "chat remains available")
    await user.click(await screen.findByRole("button", { name: /main/ }))
    await user.click(screen.getByRole("button", { name: "Pull Requests" }))
    expect(await screen.findByText("winget install --id GitHub.cli")).toBeVisible()
    expect(composer).toHaveValue("chat remains available")
  })
})
