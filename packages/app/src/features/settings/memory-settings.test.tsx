import { QueryClientProvider } from "@tanstack/solid-query"
import { createMemoryHistory, MemoryRouter, Route } from "@solidjs/router"
import { cleanup, render, screen, waitFor, within } from "@solidjs/testing-library"
import userEvent from "@testing-library/user-event"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { createDesktopQueryClient } from "../../data/query-client"
import { DesktopBridgeProvider } from "../../platform/context"
import { createFakeDesktop } from "../../test/fake-desktop"
import type { ManagementContextValue } from "../management/management-context"
import { MemoryManagementPage, MemorySettings } from "./memory-settings"

const userEntry = {
  id: "usr_language",
  scope: "user" as const,
  importance: 8,
  date: "20260718",
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

const experienceEntry = {
  id: "exp_pptx",
  scope: "experience" as const,
  kind: "success" as const,
  importance: 7,
  date: "20260807",
  updatedAt: "20260807",
  keywords: ["PPT", "QA"],
  content: "制作PPT后使用LibreOffice渲染QA可发现溢出问题",
  evidence: "[ses_pptx#1] LibreOffice 渲染 QA",
  confidence: "high" as const,
  uses: 3,
  status: "active" as const,
  sessionID: "ses_pptx",
}

function management(entries?: (typeof userEntry)[]) {
  const memory = {
    list: vi.fn(async ({ scope }: { scope: "user" | "task" | "experience" }) => ({
      data: {
        entries: scope === "user" ? (entries ?? [userEntry]) : scope === "task" ? [taskEntry] : [experienceEntry],
        total: scope === "user" ? (entries?.length ?? 1) : 1,
      },
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

function renderMemory(scope: "user" | "task" | "experience" = "user", entries?: (typeof userEntry)[]) {
  const desktop = createFakeDesktop()
  const { value, memory } = management(entries)
  const history = createMemoryHistory()
  history.set({ value: "/", replace: true, scroll: false })
  render(() => (
    <MemoryRouter history={history}>
      <Route
        path="/"
        component={() => (
          <DesktopBridgeProvider bridge={desktop.bridge}>
            <QueryClientProvider client={value.queryClient}>
              <MemoryManagementPage management={value} scope={scope} />
            </QueryClientProvider>
          </DesktopBridgeProvider>
        )}
      />
    </MemoryRouter>
  ))
  return { desktop, value, memory }
}

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})
beforeEach(() => {
  Object.defineProperties(HTMLDialogElement.prototype, {
    showModal: {
      configurable: true,
      value(this: HTMLDialogElement) {
        this.setAttribute("open", "")
      },
    },
    close: {
      configurable: true,
      value(this: HTMLDialogElement) {
        this.removeAttribute("open")
        this.dispatchEvent(new Event("close"))
      },
    },
  })
})

describe("MemorySettings", () => {
  it("links to separate user and task management pages", () => {
    const history = createMemoryHistory()
    history.set({ value: "/settings/advanced?returnTo=%2Fworkspace", replace: true, scroll: false })
    render(() => (
      <MemoryRouter history={history}>
        <Route path="/settings/advanced" component={MemorySettings} />
      </MemoryRouter>
    ))

    expect(screen.getByRole("link", { name: /用户记忆/ })).toHaveAttribute(
      "href",
      "/settings/memory/user?returnTo=%2Fworkspace",
    )
    expect(screen.getByRole("link", { name: /任务记忆/ })).toHaveAttribute(
      "href",
      "/settings/memory/task?returnTo=%2Fworkspace",
    )
    expect(screen.getByRole("link", { name: /经验记忆/ })).toHaveAttribute(
      "href",
      "/settings/memory/experience?returnTo=%2Fworkspace",
    )
    expect(screen.queryByText("用户偏好简体中文。")).not.toBeInTheDocument()
  })

  it("loads and searches all task memories without asking for a Session ID", async () => {
    const { memory } = renderMemory("task")
    const user = userEvent.setup()
    expect(await screen.findByText("用户要求完成设置，我完成了设置。")).toBeVisible()
    expect(screen.queryByRole("textbox", { name: "Session ID" })).not.toBeInTheDocument()
    expect(memory.list).toHaveBeenCalledWith(expect.objectContaining({ scope: "task" }), { throwOnError: true })
    expect(memory.list.mock.calls[0]?.[0]).not.toHaveProperty("sessionID")

    await user.type(screen.getByRole("searchbox", { name: "搜索记忆" }), "设置")
    await waitFor(() =>
      expect(memory.list).toHaveBeenCalledWith(expect.objectContaining({ scope: "task", query: "设置" }), {
        throwOnError: true,
      }),
    )
  })

  it("lists experience entries with kind and confidence", async () => {
    const { memory } = renderMemory("experience")
    expect(await screen.findByText(experienceEntry.content)).toBeVisible()
    expect(screen.getByText("成功")).toBeVisible()
    expect(screen.getByText("高")).toBeVisible()
    expect(memory.list).toHaveBeenCalledWith(expect.objectContaining({ scope: "experience" }), {
      throwOnError: true,
    })
  })

  it("edits experience kind, confidence, and content", async () => {
    const { memory } = renderMemory("experience")
    const user = userEvent.setup()
    await screen.findByText(experienceEntry.content)
    await user.click(screen.getByRole("button", { name: "编辑记忆" }))
    const dialog = screen.getByRole("dialog", { name: "编辑记忆" })
    await user.selectOptions(within(dialog).getByRole("combobox", { name: "类型" }), "lesson")
    await user.selectOptions(within(dialog).getByRole("combobox", { name: "置信度" }), "medium")
    const content = within(dialog).getByRole("textbox", { name: "内容" })
    await user.clear(content)
    await user.type(content, "渲染 QA 应作为 PPT 交付前的强制步骤")
    await user.click(within(dialog).getByRole("button", { name: "保存" }))
    await waitFor(() =>
      expect(memory.update).toHaveBeenCalledWith(
        expect.objectContaining({
          scope: "experience",
          id: "exp_pptx",
          body: {
            kind: "lesson",
            confidence: "medium",
            importance: 7,
            keywords: ["PPT", "QA"],
            content: "渲染 QA 应作为 PPT 交付前的强制步骤",
          },
        }),
        { throwOnError: true },
      ),
    )
  })

  it("deletes experience memory after confirmation", async () => {
    const { memory } = renderMemory("experience")
    const user = userEvent.setup()
    await screen.findByText(experienceEntry.content)
    await user.click(screen.getByRole("button", { name: "删除记忆" }))
    const dialog = screen.getByRole("dialog", { name: "删除记忆" })
    await user.click(within(dialog).getByRole("button", { name: "确认删除" }))
    await waitFor(() =>
      expect(memory.remove).toHaveBeenCalledWith(expect.objectContaining({ scope: "experience", id: "exp_pptx" }), {
        throwOnError: true,
      }),
    )
  })

  it("shows an empty memory store without throwing", async () => {
    renderMemory("user", [])

    await waitFor(() => expect(document.querySelector(".memory-settings__empty")).toBeInTheDocument())
    expect(document.querySelector(".memory-settings__entry")).not.toBeInTheDocument()
  })

  it("shows memory dates newest first and uses compact header actions", async () => {
    const older = { ...userEntry, id: "usr_old", date: "20260701", content: "Older memory" }
    renderMemory("user", [older, userEntry])

    await screen.findByText(userEntry.content)
    const cards = [...document.querySelectorAll<HTMLElement>(".memory-settings__entry")]
    expect(cards).toHaveLength(2)
    expect(cards[0]).toHaveTextContent(userEntry.content)
    expect(cards[0]).toHaveTextContent("2026-07-18")
    const actions = cards[0]!.querySelector(".memory-settings__entry-actions")!
    const actionButtons = actions.querySelectorAll("button")
    expect(actionButtons).toHaveLength(2)
    expect(actionButtons[0]).toHaveAttribute("data-size", "icon")
    expect(actionButtons[1]).toHaveAttribute("data-size", "icon")
    expect(actions).toHaveTextContent("")
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
    await waitFor(() =>
      expect(memory.update).toHaveBeenCalledWith(
        expect.objectContaining({
          scope: "user",
          id: "usr_language",
          body: {
            importance: 8,
            keywords: ["语言"],
            content: "用户偏好 English。",
          },
        }),
        { throwOnError: true },
      ),
    )
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
    await waitFor(() =>
      expect(memory.compact).toHaveBeenCalledWith({ scope: "user", sessionID: undefined }, { throwOnError: true }),
    )

    cleanup()
    const task = renderMemory("task")
    await screen.findByText("用户要求完成设置，我完成了设置。")
    await user.click(screen.getByRole("button", { name: "清空任务记忆" }))
    dialog = screen.getByRole("dialog", { name: "清空任务记忆" })
    await user.click(within(dialog).getByRole("button", { name: "确认清空" }))
    await waitFor(() => expect(task.memory.task.clear).toHaveBeenCalledWith({}, { throwOnError: true }))
  })

  it("exports normalized JSON with a scoped filename through the desktop bridge", async () => {
    const { desktop, memory } = renderMemory()
    const user = userEvent.setup()
    await screen.findByText("用户偏好简体中文。")
    await user.click(screen.getByRole("button", { name: "导出记忆" }))
    await waitFor(() => expect(memory.export).toHaveBeenCalledWith({ scope: "user" }, { throwOnError: true }))
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
