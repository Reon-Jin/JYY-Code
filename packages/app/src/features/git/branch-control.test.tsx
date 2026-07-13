import type { VcsBranches } from "@jyycode-ai/sdk/v2/client"
import { cleanup, render, screen, waitFor, within } from "@solidjs/testing-library"
import userEvent from "@testing-library/user-event"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { BranchControlView } from "./branch-control"

const branches: VcsBranches = {
  current: "main",
  branches: [
    { name: "main", kind: "local", current: true },
    { name: "feature/desktop", kind: "local", current: false },
    { name: "origin/main", kind: "remote", current: false, remote: "origin" },
  ],
  remotes: [{ name: "origin" }],
}

function installDialog() {
  Object.defineProperties(HTMLDialogElement.prototype, {
    close: {
      configurable: true,
      value(this: HTMLDialogElement) {
        this.removeAttribute("open")
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

function renderControl(overrides?: { current?: string; actions?: Record<string, ReturnType<typeof vi.fn>> }) {
  const actions = {
    createBranch: vi.fn(async () => branches),
    switchBranch: vi.fn(async () => branches),
    fetch: vi.fn(async () => branches),
    push: vi.fn(async () => branches),
    ...overrides?.actions,
  }
  render(() => (
    <BranchControlView
      current={overrides && "current" in overrides ? overrides.current : "main"}
      branches={branches}
      actions={actions}
    />
  ))
  return actions
}

beforeEach(installDialog)
afterEach(cleanup)

describe("BranchControl", () => {
  it("shows No Git and disables mutations outside a Git repository", () => {
    renderControl({ current: undefined })
    expect(screen.getByRole("button", { name: /No Git/ })).toBeDisabled()
  })

  it("searches grouped branches and creates a tracking branch for a remote", async () => {
    const user = userEvent.setup()
    const actions = renderControl()
    await user.click(screen.getByRole("button", { name: /main/ }))
    const dialog = screen.getByRole("dialog")
    expect(within(dialog).getByRole("heading", { name: "本地" })).toBeVisible()
    expect(within(dialog).getByRole("heading", { name: "远程" })).toBeVisible()
    await user.type(within(dialog).getByPlaceholderText("搜索本地与远程分支"), "origin")
    expect(within(dialog).queryByText("feature/desktop")).not.toBeInTheDocument()
    await user.click(within(dialog).getByRole("button", { name: /origin\/main/ }))
    expect(actions.switchBranch).toHaveBeenCalledWith({ name: "origin/main", createLocal: true })
  })

  it("validates names and reports Fetch and Push without locking chat", async () => {
    const user = userEvent.setup()
    const actions = renderControl()
    await user.click(screen.getByRole("button", { name: /main/ }))
    const dialog = screen.getByRole("dialog")
    await user.click(within(dialog).getByRole("button", { name: "新建分支" }))
    expect(within(dialog).getByRole("alert")).toHaveTextContent("请输入分支名称")
    await user.type(within(dialog).getByLabelText("新分支名称"), "bad..name")
    await user.click(within(dialog).getByRole("button", { name: "新建分支" }))
    expect(within(dialog).getByRole("alert")).toHaveTextContent("不允许")
    await user.click(within(dialog).getByRole("button", { name: "Fetch" }))
    await waitFor(() => expect(within(dialog).getByRole("status")).toHaveTextContent("Fetch 完成"))
    await user.click(within(dialog).getByRole("button", { name: "Push" }))
    await waitFor(() => expect(actions.push).toHaveBeenCalledWith({}))
  })
})
