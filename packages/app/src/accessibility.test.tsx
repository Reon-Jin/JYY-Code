// @ts-nocheck
import { cleanup, render, screen, waitFor } from "@solidjs/testing-library"
import userEvent from "@testing-library/user-event"
import { readFileSync } from "node:fs"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { App } from "./app"
import { createFakeDesktop } from "./test/fake-desktop"
import { createFakeJyycode } from "./test/fake-jyycode"

function unnamedIconButtons(root: ParentNode) {
  return [...root.querySelectorAll<HTMLButtonElement>("button")].filter((button) => {
    const name = button.getAttribute("aria-label") ?? button.textContent ?? ""
    return !name.trim()
  })
}

describe("desktop accessibility contract", () => {
  beforeEach(() => {
    Object.defineProperty(window, "scrollTo", { configurable: true, value: vi.fn() })
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
    window.history.replaceState(null, "", "/")
  })

  afterEach(() => {
    cleanup()
    vi.unstubAllGlobals()
  })

  it("keeps landmarks, controls, focus, alerts, and live status accessible", async () => {
    const user = userEvent.setup()
    const desktop = createFakeDesktop()
    const backend = createFakeJyycode(desktop.directory)
    vi.stubGlobal("fetch", backend.fetch)
    const { container } = render(() => <App bridge={desktop.bridge} />)

    expect(await screen.findAllByRole("main", {}, { timeout: 5_000 })).toHaveLength(1)
    expect(unnamedIconButtons(container)).toEqual([])
    const trigger = await screen.findByRole("button", { name: /新建项目/ })
    trigger.focus()
    await user.keyboard("{Enter}")
    expect(screen.getByRole("dialog", { name: "新建项目" })).toBeVisible()
    const dialog = screen.getByRole("dialog", { name: "新建项目" })
    dialog.dispatchEvent(new Event("cancel", { cancelable: true }))
    await waitFor(() => expect(trigger).toHaveFocus())

    await user.keyboard("{Enter}")
    const submit = screen.getByRole("button", { name: "创建并进入" })
    submit.focus()
    await user.keyboard("{Enter}")
    expect(await screen.findByRole("alert")).toHaveTextContent("请选择父目录")
    expect(screen.getByRole("textbox", { name: "父目录" })).toHaveFocus()
  })

  it("keeps global management navigation and destructive dialogs accessible", async () => {
    const user = userEvent.setup()
    const desktop = createFakeDesktop()
    const backend = createFakeJyycode(desktop.directory)
    vi.stubGlobal("fetch", backend.fetch)
    const { container } = render(() => <App bridge={desktop.bridge} />)

    expect(await screen.findAllByRole("main", {}, { timeout: 5_000 })).toHaveLength(1)
    const navigation = await screen.findByRole("navigation", { name: "全局管理" })
    expect(navigation).toBeVisible()
    expect(screen.getByRole("link", { name: "首页" })).toHaveAttribute("aria-current", "page")
    expect(unnamedIconButtons(container)).toEqual([])

    const skillLink = screen.getByRole("link", { name: "Skill" })
    skillLink.focus()
    await user.keyboard("{Enter}")
    expect(screen.getByRole("link", { name: "Skill" })).toHaveAttribute("aria-current", "page")
    await user.click(await screen.findByRole("button", { name: "打开 Skill desktop-helper" }))

    const trigger = await screen.findByRole("button", { name: "删除" })
    trigger.focus()
    await user.keyboard("{Enter}")
    const dialog = screen.getByRole("dialog", { name: "删除 Skill" })
    expect(dialog).toHaveAttribute("aria-describedby")
    expect(screen.getByRole("button", { name: "确认删除" })).toBeVisible()
    await user.click(screen.getByRole("button", { name: "取消" }))
    await waitFor(() => expect(trigger).toHaveFocus())
    expect(unnamedIconButtons(container)).toEqual([])
  })

  it("labels the project, Session, Agent, model, and Composer controls after restore", async () => {
    const desktop = createFakeDesktop({
      lastLocation: { project: "C:\\work\\demo", sessionID: "ses_1" },
    })
    const backend = createFakeJyycode(desktop.directory)
    backend.sessions.push({
      id: "ses_1",
      slug: "session-1",
      projectID: backend.project.id,
      directory: desktop.directory,
      title: "New session",
      version: "test",
      time: { created: 1, updated: 1 },
    })
    backend.messages.set("ses_1", [])
    vi.stubGlobal("fetch", backend.fetch)
    const { container } = render(() => <App bridge={desktop.bridge} />)

    expect(await screen.findByRole("complementary", { name: "项目与 Session 导航" }, { timeout: 5_000 })).toBeVisible()
    expect(screen.getByRole("navigation", { name: "活动 Session" })).toBeVisible()
    expect(await screen.findByRole("combobox", { name: "智能体" }, { timeout: 5_000 })).toBeVisible()
    expect(screen.getByRole("button", { name: "配置模型：Test · Test Model" })).toBeVisible()
    expect(screen.getByRole("region", { name: "消息编辑器" })).toBeVisible()
    expect(screen.getByRole("textbox", { name: "消息" })).toBeVisible()
    expect(screen.getByRole("navigation", { name: "工作栏页面" })).toBeVisible()
    expect(screen.getByRole("button", { name: "待办" })).toHaveAttribute("aria-pressed", "false")
    expect(screen.getByRole("button", { name: "多智能体" })).toHaveAttribute("aria-pressed", "false")
    expect(screen.getByRole("button", { name: "工作区变更" })).toHaveAttribute("aria-pressed", "false")
    expect(container.querySelector(".branch-control__trigger")).toHaveAttribute("aria-haspopup", "dialog")
    expect(container.querySelector(".workspace-connection__status")).toHaveAttribute("aria-live", "polite")
    expect(unnamedIconButtons(container)).toEqual([])
  })

  it("keeps Settings navigation, choices, placeholders, and return focus keyboard-operable", async () => {
    const user = userEvent.setup()
    const desktop = createFakeDesktop()
    const backend = createFakeJyycode(desktop.directory)
    vi.stubGlobal("fetch", backend.fetch)
    render(() => <App bridge={desktop.bridge} />)

    const settings = await screen.findByRole("link", { name: "设置" }, { timeout: 5_000 })
    settings.focus()
    await user.keyboard("{Enter}")
    expect(await screen.findByRole("heading", { name: "设置" })).toBeVisible()

    const light = await screen.findByRole("radio", { name: "浅色" })
    light.focus()
    await user.keyboard(" ")
    expect(light).toBeChecked()

    const security = screen.getByRole("link", { name: "权限与安全" })
    security.focus()
    await user.keyboard("{Enter}")
    expect(await screen.findByRole("heading", { name: "权限与安全" })).toBeVisible()
    expect(await screen.findByRole("radio", { name: "自动" })).toBeEnabled()

    const advanced = screen.getByRole("link", { name: "高级" })
    advanced.focus()
    await user.keyboard("{Enter}")
    expect(await screen.findByRole("combobox", { name: "默认 Shell" })).toBeEnabled()
    expect(screen.getByLabelText("自动更新策略")).toHaveValue("notify")
    expect(screen.getByRole("region", { name: "自动更新" })).toHaveTextContent("已就绪")
    expect(await screen.findByRole("checkbox", { name: "自动压缩" })).toBeEnabled()
    expect(screen.getByRole("button", { name: "保存压缩参数" })).toBeDisabled()
    expect(screen.getByRole("heading", { name: "记忆管理" })).toBeVisible()
    const taskMemory = screen.getByRole("link", { name: /任务记忆/ })
    taskMemory.focus()
    await user.keyboard("{Enter}")
    expect(await screen.findByRole("heading", { name: "任务记忆" })).toBeVisible()
    expect(screen.queryByRole("textbox", { name: "Session ID" })).not.toBeInTheDocument()
    await user.click(screen.getByRole("button", { name: "返回" }))
    expect(await screen.findByRole("heading", { name: "高级" })).toBeVisible()

    const back = screen.getByRole("button", { name: "返回" })
    back.focus()
    await user.keyboard("{Enter}")
    await waitFor(() => expect(screen.getByRole("link", { name: "设置" })).toHaveFocus())
  })

  it("keeps the Multi-Agent drawer, task, model dialog, and child route keyboard-operable", async () => {
    const user = userEvent.setup()
    const desktop = createFakeDesktop({ lastLocation: { project: "C:\\work\\demo", sessionID: "ses_root" } })
    const backend = createFakeJyycode(desktop.directory)
    backend.addSession({ id: "ses_root", slug: "root", title: "Root Session", multiAgent: true })
    backend.addSession({
      id: "ses_child",
      slug: "child",
      title: "Coder Session",
      parentID: "ses_root",
      agent: "coder",
      model: { providerID: "test", id: "test-complex" },
    })
    backend.setAgentCluster("ses_root", {
      runs: [
        {
          id: "run_1",
          session_id: "ses_root",
          parent_message_id: "msg_parent",
          enabled: true,
          status: "dispatching",
          goal: "Accessible workflow",
          planner_model: "test/test-planner",
          reviewer_model: "test/test-planner",
          time_created: 1,
          time_updated: 2,
          completed_at: 0,
        },
      ],
      tasks: [
        {
          id: "code",
          run_id: "run_1",
          parent_task_id: "",
          child_session_id: "ses_child",
          role: "coder",
          title: "Keyboard task",
          prompt: "Implement",
          complexity: "complex",
          model: "test/test-complex",
          status: "running",
          step: 1,
          dependencies: [],
          review_round: 0,
          acceptance_criteria: [],
          artifact_paths: [],
          result_summary: "",
          review_issues: [],
          last_event: "Started coding",
          time_created: 2,
          time_updated: 2,
        },
      ],
    })
    vi.stubGlobal("fetch", backend.fetch)
    render(() => <App bridge={desktop.bridge} />)

    const mode = await screen.findByRole("switch", { name: "多智能体" }, { timeout: 5_000 })
    mode.focus()
    expect(mode).toHaveFocus()
    expect(mode).toHaveAttribute("aria-checked", "true")

    const openPanel = screen.getByRole("button", { name: "多智能体" })
    openPanel.focus()
    await user.keyboard("{Enter}")
    expect(openPanel).toHaveFocus()
    const progress = await screen.findByRole("progressbar", { name: "多智能体进度" })
    expect(progress).toHaveAttribute("aria-valuemin", "0")
    expect(progress).toHaveAttribute("aria-valuemax", "1")
    expect(progress).toHaveAttribute("aria-valuenow", "0")

    for (const name of ["待办", "多智能体", "工作区变更"]) {
      const button = screen.getByRole("button", { name })
      button.focus()
      expect(button).toHaveFocus()
      expect(button).toHaveAttribute("aria-pressed")
    }
    expect(screen.getByRole("button", { name: "多智能体" })).toHaveAttribute("aria-pressed", "true")

    const disclosure = screen.getByText("Keyboard task").closest("summary")!
    disclosure.focus()
    expect(disclosure).toHaveFocus()
    await user.click(disclosure)
    expect(screen.getByText("Started coding")).toBeVisible()

    const modelButton = screen.getByRole("button", { name: /配置模型/ })
    modelButton.focus()
    await user.keyboard("{Enter}")
    const modelDialog = screen.getByRole("dialog", { name: "配置模型" })
    const selects = await modelDialog.querySelectorAll("select")
    expect(selects).toHaveLength(8)
    for (const select of selects) {
      select.focus()
      expect(select).toHaveFocus()
    }
    const close = screen.getByRole("button", { name: "关闭" })
    close.focus()
    await user.keyboard("{Enter}")
    await waitFor(() => expect(modelButton).toHaveFocus())

    await user.keyboard("{Enter}")
    const save = await screen.findByRole("button", { name: "保存" })
    save.focus()
    await user.keyboard("{Enter}")
    await waitFor(() => expect(modelButton).toHaveFocus())

    const openChild = screen.getByRole("button", { name: "审阅：Keyboard task" })
    openChild.focus()
    await user.keyboard("{Enter}")
    expect(await screen.findByRole("heading", { name: "Coder Session" })).toBeVisible()
    expect(screen.getByRole("link", { name: /Root Session/ })).toHaveAttribute("aria-current", "page")
    expect(screen.queryByRole("button", { name: /当前模型/ })).not.toBeInTheDocument()
    expect(screen.getByRole("textbox", { name: "消息" })).toBeEnabled()
    const back = screen.getByRole("button", { name: "返回主 Session" })
    back.focus()
    await user.keyboard("{Enter}")
    expect(await screen.findByRole("heading", { name: "Root Session" })).toBeVisible()
  }, 15_000)

  it("defines a reduced-motion override for nonessential transitions", () => {
    const stylesheet = readFileSync("src/styles/global.css", "utf8")
    expect(stylesheet).toMatch(/prefers-reduced-motion:\s*reduce/)
    expect(stylesheet).toMatch(/transition-duration:\s*0\.01ms/)
  })
})
// @ts-nocheck
