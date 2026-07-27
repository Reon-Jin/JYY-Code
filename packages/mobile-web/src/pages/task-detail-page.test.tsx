import { cleanup, render, screen } from "@solidjs/testing-library"
import userEvent from "@testing-library/user-event"
import { afterEach, expect, test, vi } from "vitest"
import { TaskDetailPage } from "./task-detail-page"
import type { RemoteTask } from "../lib/models"

afterEach(cleanup)

const task: RemoteTask = {
  id: "one", deviceID: "desktop", project: "桌面端", title: "修复设置页面", status: "running", summary: "正在处理任务。", progress: 0.4,
  updatedAt: new Date().toISOString(), todo: [{ id: "todo", title: "补充测试", isComplete: false }], children: [], pending: null, timeline: [],
}

test("仅在用户打开对话时才请求完整内容", async () => {
  const user = userEvent.setup()
  const onCommand = vi.fn(async () => ({ kind: "conversation" as const, content: "完整对话" }))
  render(() => <TaskDetailPage task={task} online onBack={vi.fn()} onCommand={onCommand} />)
  expect(onCommand).not.toHaveBeenCalled()
  await user.click(screen.getByRole("button", { name: "对话" }))
  await user.click(screen.getByRole("button", { name: "加载对话" }))
  expect(onCommand).toHaveBeenCalledWith({ type: "loadConversation" })
  expect(await screen.findByText("完整对话")).toBeVisible()
})

test("失败任务可以重试，问题可以提交自由回答", async () => {
  const user = userEvent.setup()
  const onCommand = vi.fn(async () => undefined)
  const waiting: RemoteTask = {
    ...task,
    status: "waiting",
    pending: { type: "question", id: "question", title: "请选择或输入回答", options: [] },
  }
  const { unmount } = render(() => <TaskDetailPage task={waiting} online onBack={vi.fn()} onCommand={onCommand} />)
  await user.type(screen.getByPlaceholderText("输入你的回答"), "继续执行")
  await user.click(screen.getByRole("button", { name: "发送回答" }))
  expect(onCommand).toHaveBeenCalledWith({ type: "answerQuestion", id: "question", answer: "继续执行" })
  unmount()

  render(() => <TaskDetailPage task={{ ...task, status: "failed" }} online onBack={vi.fn()} onCommand={onCommand} />)
  await user.click(screen.getByRole("button", { name: "重试任务" }))
  expect(onCommand).toHaveBeenCalledWith({ type: "retry" })
})
