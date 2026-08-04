import { cleanup, render, screen } from "@solidjs/testing-library"
import userEvent from "@testing-library/user-event"
import { afterEach, expect, test, vi } from "vitest"
import { WorkbenchPage } from "./workbench-page"
import type { RemoteTask } from "../lib/models"

afterEach(cleanup)

const tasks: RemoteTask[] = [
  {
    id: "one",
    deviceID: "desktop",
    project: "桌面端",
    title: "修复设置页面",
    status: "running",
    summary: "正在处理任务。",
    progress: 0.4,
    updatedAt: new Date().toISOString(),
    todo: [],
    children: [],
    pending: null,
    timeline: [],
  },
  {
    id: "two",
    deviceID: "desktop",
    project: "官网改版",
    title: "确认设计稿",
    status: "waiting",
    summary: "等待你的处理。",
    progress: 0.2,
    updatedAt: new Date().toISOString(),
    todo: [],
    children: [],
    pending: { type: "question", id: "question", title: "确认设计稿", options: ["确认"] },
    timeline: [],
  },
]

test("可以从全部项目快速切换到单个项目", async () => {
  const user = userEvent.setup()
  const onProject = vi.fn()
  render(() => (
    <WorkbenchPage
      tasks={tasks}
      selectedProject="全部项目"
      online
      deviceName="办公室 Windows"
      onProject={onProject}
      onDevices={vi.fn()}
      onOpenTask={vi.fn()}
      onRefresh={vi.fn()}
      onCreate={async () => undefined}
    />
  ))
  expect(screen.getByText("修复设置页面")).toBeVisible()
  expect(screen.getAllByText("确认设计稿").length).toBeGreaterThan(0)
  await user.click(screen.getByRole("button", { name: "官网改版" }))
  expect(onProject).toHaveBeenCalledWith("官网改版")
})
