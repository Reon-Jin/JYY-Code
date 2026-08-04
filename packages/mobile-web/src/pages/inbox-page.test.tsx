import { cleanup, render, screen } from "@solidjs/testing-library"
import userEvent from "@testing-library/user-event"
import { afterEach, expect, test, vi } from "vitest"
import { InboxPage } from "./inbox-page"
import type { RemoteTask } from "../lib/models"

afterEach(cleanup)

const tasks: RemoteTask[] = [
  {
    id: "failed",
    deviceID: "desktop",
    project: "官网改版",
    title: "构建失败",
    status: "failed",
    summary: "任务需要重试。",
    progress: 0,
    updatedAt: new Date().toISOString(),
    todo: [],
    children: [],
    pending: null,
    timeline: [],
  },
  {
    id: "permission",
    deviceID: "desktop",
    project: "桌面端",
    title: "更新设置",
    status: "waiting",
    summary: "等待你的处理。",
    progress: 0,
    updatedAt: new Date().toISOString(),
    todo: [],
    children: [],
    pending: { type: "permission", id: "permission-request", title: "需要批准权限" },
    timeline: [],
  },
]

test("待处理页按类别筛选并保留项目来源", async () => {
  const user = userEvent.setup()
  render(() => <InboxPage tasks={tasks} onOpenTask={vi.fn()} />)
  expect(screen.getByText("官网改版")).toBeVisible()
  expect(screen.getByText("桌面端")).toBeVisible()
  await user.click(screen.getByRole("button", { name: "失败" }))
  expect(screen.getByText("构建失败")).toBeVisible()
  expect(screen.queryByText("需要批准权限")).not.toBeInTheDocument()
})
