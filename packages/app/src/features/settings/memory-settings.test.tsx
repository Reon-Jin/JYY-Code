import { QueryClientProvider } from "@tanstack/solid-query"
import { cleanup, render, screen, waitFor, within } from "@solidjs/testing-library"
import userEvent from "@testing-library/user-event"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { createDesktopQueryClient } from "../../data/query-client"
import { DesktopBridgeProvider } from "../../platform/context"
import { createFakeDesktop } from "../../test/fake-desktop"
import type { ManagementContextValue } from "../management/management-context"
import { MemorySettings } from "./memory-settings"

const userEntry = {
  id: "usr_language",
  scope: "user" as const,
  importance: 8,
  keywords: ["语言"],
  content: "用户偏好简体中文。",
}
const taskEntry = {
  id: "tsk_settings",
  scope: "task" as const,
  importance: 6,
  date: "20260716",
  keywords: ["设置"],
  content: "用户要求完成设置，我完成了设置。",
  sessionID: "ses_settings",
}

function management() {
  const memory = {
    list: vi.fn(async ({ scope, sessionID }: { scope: "user" | "task"; sessionID?: string }) => ({
      data: { entries: scope === "user" ? [userEntry] : sessionID ? [taskEntry] : [], total: 1 },
    })),
    update: vi.fn(async (input: Record<string, unknown>) => ({ data: { ...userEntry, ...input } })),
    remove: vi.fn(async () => ({ data: { removed: true } })),
    compact: vi.fn(async () => ({ data: { removed: 0, merged: 0, retained: 1 } })),
    export: vi.fn(async () => ({ data: { schemaVersion: 3, lastCompactedAt: null, entries: [] } })),
    user: { create: vi.fn(async (input: Record<string, unknown>) => ({ data: { ...userEntry, ...input } })) },
    task: { clear: vi.fn(async () => ({ data: { removed: 1 } })) },
  }
  const value = {
    client: { global: { memory } },
    queryClient: createDesktopQueryClient(),
    directory: "C:\\Users\\dev",
  } as unknown as ManagementContextValue & { client: { global: { memory: typeof memory } } }
  return { value, memory }
}

function renderMemory() {
  const desktop = createFakeDesktop()
  const { value, memory } = management()
  render(() => (
    <DesktopBridgeProvider bridge={desktop.bridge}>
      <QueryClientProvider client={value.queryClient}>
        <MemorySettings management={value} />
      </QueryClientProvider>
    </DesktopBridgeProvider>
  ))
  return { desktop, value, memory }
}

afterEach(() => { cleanup(); vi.restoreAllMocks() })
beforeEach(() => {
  Object.defineProperties(HTMLDialogElement.prototype, {
    showModal: { configurable: true, value(this: HTMLDialogElement) { this.setAttribute("open", "") } },
    close: { configurable: true, value(this: HTMLDialogElement) {
      this.removeAttribute("open")
      this.dispatchEvent(new Event("close"))
    } },
  })
})

describe("MemorySettings", () => {
  it("loads user memory by default and waits for a task Session before debounced search", async () => {
    const { memory } = renderMemory()
    const user = userEvent.setup()
    expect(await screen.findByText("用户偏好简体中文。")).toBeVisible()
    expect(memory.list).toHaveBeenCalledWith(expect.objectContaining({ scope: "user" }), { throwOnError: true })

    await user.click(screen.getByRole("tab", { name: "任务记忆" }))
    expect(screen.getByText("请先输入 Session ID")).toBeVisible()
    const session = screen.getByRole("textbox", { name: "Session ID" })
    await user.type(session, "ses_settings")
    expect(await screen.findByText("用户要求完成设置，我完成了设置。")).toBeVisible()

    await user.type(screen.getByRole("searchbox", { name: "搜索记忆" }), "设置")
    await waitFor(() => expect(memory.list).toHaveBeenCalledWith(
      expect.objectContaining({ scope: "task", sessionID: "ses_settings", query: "设置" }),
      { throwOnError: true },
    ))
  })

  it("edits schema fields and refreshes the active query", async () => {
    const { memory } = renderMemory()
    const user = userEvent.setup()
    await screen.findByText("用户偏好简体中文。")
    await user.click(screen.getByRole("button", { name: "编辑记忆" }))
    const dialog = screen.getByRole("dialog", { name: "编辑记忆" })
    const content = within(dialog).getByRole("textbox", { name: "内容" })
    await user.clear(content)
    await user.type(content, "用户偏好 English。")
    await user.click(within(dialog).getByRole("button", { name: "保存" }))
    await waitFor(() => expect(memory.update).toHaveBeenCalledWith(
      expect.objectContaining({ scope: "user", id: "usr_language", importance: 8, keywords: ["语言"], content: "用户偏好 English。" }),
      { throwOnError: true },
    ))
    await waitFor(() => expect(memory.list.mock.calls.length).toBeGreaterThan(1))
  })

  it("requires separate confirmations for delete, compact, and task clearing", async () => {
    const { memory } = renderMemory()
    const user = userEvent.setup()
    await screen.findByText("用户偏好简体中文。")
    await user.click(screen.getByRole("button", { name: "删除记忆" }))
    let dialog = screen.getByRole("dialog", { name: "删除记忆" })
    await user.click(within(dialog).getByRole("button", { name: "取消" }))
    expect(memory.remove).not.toHaveBeenCalled()

    await user.click(screen.getByRole("button", { name: "删除记忆" }))
    dialog = screen.getByRole("dialog", { name: "删除记忆" })
    await user.click(within(dialog).getByRole("button", { name: "确认删除" }))
    await waitFor(() => expect(memory.remove).toHaveBeenCalled())

    await user.click(screen.getByRole("button", { name: "压缩记忆" }))
    dialog = screen.getByRole("dialog", { name: "压缩记忆" })
    await user.click(within(dialog).getByRole("button", { name: "确认压缩" }))
    await waitFor(() => expect(memory.compact).toHaveBeenCalledWith({ scope: "user", sessionID: undefined }, { throwOnError: true }))

    await user.click(screen.getByRole("tab", { name: "任务记忆" }))
    await user.type(screen.getByRole("textbox", { name: "Session ID" }), "ses_settings")
    await screen.findByText("用户要求完成设置，我完成了设置。")
    await user.click(screen.getByRole("button", { name: "清空任务记忆" }))
    dialog = screen.getByRole("dialog", { name: "清空任务记忆" })
    await user.click(within(dialog).getByRole("button", { name: "确认清空" }))
    await waitFor(() => expect(memory.task.clear).toHaveBeenCalledWith({ sessionID: "ses_settings" }, { throwOnError: true }))
  })

  it("exports normalized JSON with a scoped filename through the desktop bridge", async () => {
    const { desktop, memory } = renderMemory()
    const user = userEvent.setup()
    await screen.findByText("用户偏好简体中文。")
    await user.click(screen.getByRole("button", { name: "导出记忆" }))
    await waitFor(() => expect(memory.export).toHaveBeenCalledWith({ scope: "user", sessionID: undefined }, { throwOnError: true }))
    expect(desktop.bridge.saveTextFile).toHaveBeenCalledWith(
      expect.stringMatching(/^jyycode-memory-user-\d{8}\.json$/),
      expect.stringContaining('"schemaVersion": 3'),
    )
  })

  it("keeps editor input when saving fails", async () => {
    const { memory } = renderMemory()
    memory.update.mockRejectedValueOnce(new Error("保存失败"))
    const user = userEvent.setup()
    await screen.findByText("用户偏好简体中文。")
    await user.click(screen.getByRole("button", { name: "编辑记忆" }))
    const dialog = screen.getByRole("dialog", { name: "编辑记忆" })
    const content = within(dialog).getByRole("textbox", { name: "内容" })
    await user.clear(content)
    await user.type(content, "用户偏好 English。")
    await user.click(within(dialog).getByRole("button", { name: "保存" }))
    expect(await within(dialog).findByRole("alert")).toHaveTextContent("保存失败")
    expect(content).toHaveValue("用户偏好 English。")
  })
})
