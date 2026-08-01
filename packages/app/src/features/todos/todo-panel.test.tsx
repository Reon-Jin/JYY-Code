import type { Todo } from "@jyycode-ai/sdk/v2/client"
import { cleanup, render, screen, waitFor, within } from "@solidjs/testing-library"
import userEvent from "@testing-library/user-event"
import { afterEach, describe, expect, it, vi } from "vitest"
import { DataProvider } from "../../data/context"
import { createFakeJyycode } from "../../test/fake-jyycode"
import { TodoPanel, TodoPanelView } from "./todo-panel"

const directory = "C:\\work\\demo"

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

describe("TodoPanel", () => {
  it("preserves backend order and describes every todo status", () => {
    const todos: Todo[] = [
      { content: "Pending task", status: "pending", priority: "low" },
      { content: "Active task", status: "in_progress", priority: "high" },
      { content: "Completed task", status: "completed", priority: "medium" },
      { content: "Cancelled task", status: "cancelled", priority: "low" },
    ]

    render(() => <TodoPanelView directory={directory} sessionID="ses_1" todos={todos} />)

    const items = screen.getAllByRole("listitem")
    expect(items.map((item) => within(item).getByText(/task/).textContent)).toEqual([
      "Pending task",
      "Active task",
      "Completed task",
      "Cancelled task",
    ])
    expect(items[0]).toHaveTextContent("未开始")
    expect(items[1]).toHaveTextContent("进行中")
    expect(items[1]).toHaveAttribute("aria-current", "step")
    expect(items[2]).toHaveTextContent("已完成")
    expect(items[2]).toHaveClass("todo-panel__item--completed")
    expect(items[3]).toHaveTextContent("已取消")
  })

  it("keeps no-session, loading, empty, and retryable error states inside the panel", async () => {
    const retry = vi.fn()
    const user = userEvent.setup()
    const { unmount } = render(() => <TodoPanelView directory={directory} />)
    expect(screen.getByText("创建或选择会话后显示步骤")).toBeVisible()
    unmount()

    const loading = render(() => <TodoPanelView directory={directory} sessionID="ses_1" loading />)
    expect(screen.getByRole("status")).toHaveTextContent("正在加载步骤")
    loading.unmount()

    const empty = render(() => <TodoPanelView directory={directory} sessionID="ses_1" todos={[]} />)
    expect(screen.getByText("当前会话暂无步骤")).toBeVisible()
    empty.unmount()

    render(() => <TodoPanelView directory={directory} sessionID="ses_1" error="offline" onRetry={retry} />)
    expect(screen.getByRole("alert")).toHaveTextContent("offline")
    await user.click(screen.getByRole("button", { name: "重试" }))
    expect(retry).toHaveBeenCalledOnce()
  })

  it("updates todo progress from SSE without remounting", async () => {
    const backend = createFakeJyycode(directory)
    backend.setTodos("ses_1", [{ content: "Realtime task", status: "pending", priority: "high" }])
    vi.spyOn(globalThis, "fetch").mockImplementation(backend.fetch)

    render(() => (
      <DataProvider
        bootstrap={{ baseUrl: "http://desktop.test", username: "jyycode", password: "secret" }}
        generation={0}
        directory={directory}
        activeSessionID={() => "ses_1"}
      >
        <TodoPanel directory={directory} sessionID="ses_1" />
      </DataProvider>
    ))

    const panel = screen.getByRole("region", { name: "方案" })
    expect(await screen.findByRole("listitem")).toHaveTextContent("未开始")

    backend.setTodos("ses_1", [{ content: "Realtime task", status: "in_progress", priority: "high" }])
    await waitFor(() => expect(screen.getByRole("listitem")).toHaveTextContent("进行中"))
    expect(screen.getByRole("listitem")).toHaveAttribute("aria-current", "step")
    expect(screen.getByRole("region", { name: "方案" })).toBe(panel)

    backend.setTodos("ses_1", [{ content: "Realtime task", status: "completed", priority: "high" }])
    await waitFor(() => expect(screen.getByRole("listitem")).toHaveTextContent("已完成"))
    expect(screen.getByRole("region", { name: "方案" })).toBe(panel)
  })
})
