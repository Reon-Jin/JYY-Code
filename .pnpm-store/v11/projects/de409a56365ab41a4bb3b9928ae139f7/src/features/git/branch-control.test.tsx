import type { VcsBranches } from "@jyycode-ai/sdk/v2/client"
import { cleanup, render, screen, waitFor, within } from "@solidjs/testing-library"
import userEvent from "@testing-library/user-event"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { BranchControlView } from "./branch-control"
import { formatBranchUpdatedAt } from "./branch-dialog"

const oneHourAgo = new Date(Date.now() - 60 * 60 * 1_000).toISOString()

const branches: VcsBranches = {
  current: "main",
  branches: [
    { name: "main", kind: "local", current: true, updatedAt: oneHourAgo },
    { name: "feature/desktop", kind: "local", current: false, updatedAt: "2026-07-13T00:00:00Z" },
    { name: "origin/main", kind: "remote", current: false, remote: "origin", updatedAt: oneHourAgo },
    { name: "origin/remote-only", kind: "remote", current: false, remote: "origin", updatedAt: oneHourAgo },
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

function renderControl(overrides?: {
  current?: string
  loadError?: string
  actions?: Record<string, ReturnType<typeof vi.fn>>
}) {
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
      loadError={overrides?.loadError}
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
    expect(screen.getByRole("button", { name: /未启用版本控制/ })).toBeDisabled()
  })

  it("shows one deduplicated branch list with update times and tracks remote-only branches", async () => {
    const user = userEvent.setup()
    const actions = renderControl()
    await user.click(screen.getByRole("button", { name: /main/ }))
    const dialog = screen.getByRole("dialog")
    expect(within(dialog).getByRole("heading", { name: "分支" })).toBeVisible()
    expect(within(dialog).queryByRole("heading", { name: "远程" })).not.toBeInTheDocument()
    expect(within(dialog).getAllByText("main")).toHaveLength(1)
    expect(within(dialog).getAllByText("1 小时前").length).toBeGreaterThan(0)
    await user.type(within(dialog).getByPlaceholderText("搜索分支"), "remote-only")
    expect(within(dialog).queryByText("feature/desktop")).not.toBeInTheDocument()
    await user.click(within(dialog).getByRole("button", { name: /remote-only/ }))
    expect(actions.switchBranch).toHaveBeenCalledWith({ name: "origin/remote-only", createLocal: true })
  })

  it("formats branch update times for the current locale", () => {
    expect(formatBranchUpdatedAt("2026-07-14T04:00:00Z", Date.parse("2026-07-14T05:00:00Z"))).toBe("1 小时前")
  })

  it("closes the branch dialog from its close button", async () => {
    const user = userEvent.setup()
    renderControl()
    await user.click(screen.getByRole("button", { name: /main/ }))
    const dialog = screen.getByRole("dialog")

    await user.click(within(dialog).getByRole("button", { name: "关闭" }))

    await waitFor(() => expect(dialog).not.toHaveAttribute("open"))
  })

  it("shows branch loading errors instead of presenting an empty result", async () => {
    const user = userEvent.setup()
    renderControl({ loadError: "无法加载分支：接口不可用" })
    await user.click(screen.getByRole("button", { name: /main/ }))

    expect(within(screen.getByRole("dialog")).getByRole("alert")).toHaveTextContent("无法加载分支：接口不可用")
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
