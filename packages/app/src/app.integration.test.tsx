// @ts-nocheck
import { cleanup, fireEvent, render, screen, waitFor, within } from "@solidjs/testing-library"
import type { SessionAgentClusterResponse } from "@jyycode-ai/sdk/v2/client"
import userEvent from "@testing-library/user-event"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { App } from "./app"
import { createFakeDesktop } from "./test/fake-desktop"
import { createFakeJyycode } from "./test/fake-jyycode"

function clusterSnapshot(): SessionAgentClusterResponse {
  return {
    tasks: [
      {
        id: "code",
        session_id: "ses_root",
        origin_message_id: "msg_parent",
        parent_task_id: "",
        child_session_id: "ses_child",
        role: "coder",
        title: "Implement feature",
        prompt: "Implement the feature",
        complexity: "complex" as const,
        model: "test/test-complex",
        status: "running" as const,
        step: 1,
        dependencies: [],
        review_round: 0,
        acceptance_criteria: ["Tests pass"],
        artifact_paths: [],
        result_summary: "",
        review_issues: [],
        last_event: "Started coding",
        time_created: 2,
        time_updated: 2,
      },
    ],
  }
}

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

describe("desktop GUI journey", () => {
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

  it("manages global Skill and MCP state, then opens a recent project from Home", async () => {
    const user = userEvent.setup()
    const directory = "C:\\work\\demo"
    const desktop = createFakeDesktop({ recentProjects: [{ path: directory, usedAt: 1 }] })
    const backend = createFakeJyycode(desktop.directory)
    vi.stubGlobal("fetch", backend.fetch)

    render(() => <App bridge={desktop.bridge} />)

    await user.click(await screen.findByRole("link", { name: "Skill" }, { timeout: 5_000 }))
    await user.click(await screen.findByRole("button", { name: "打开 Skill desktop-helper" }))
    expect(await screen.findByRole("heading", { name: "Desktop Helper" })).toBeVisible()

    await user.click(screen.getByRole("button", { name: "编辑" }))
    const editor = screen.getByRole("textbox", { name: "SKILL.md" })
    fireEvent.input(editor, {
      target: {
        value:
          "---\nname: desktop-helper\ndescription: Desktop management fixture\n---\n\n# Updated Helper\n\nSaved globally.",
      },
    })
    await user.click(screen.getByRole("button", { name: "保存" }))
    expect(await screen.findByRole("heading", { name: "Updated Helper" })).toBeVisible()
    expect(backend.skills[0]?.content).toContain("Saved globally")

    await user.click(screen.getByRole("link", { name: "首页" }))
    expect(await screen.findByRole("heading", { name: "JYYCode" })).toBeVisible()
    await user.click(screen.getByRole("link", { name: "MCP" }))
    await user.click(await screen.findByRole("button", { name: "添加 MCP" }))
    const add = screen.getByRole("dialog", { name: "添加 MCP" })
    await user.type(within(add).getByLabelText("名称"), "docs")
    await user.selectOptions(within(add).getByLabelText("类型"), "remote")
    await user.type(within(add).getByLabelText("URL"), "https://mcp.example.test/api")
    await user.click(within(add).getByRole("checkbox", { name: "启用" }))
    await user.click(within(add).getByRole("button", { name: "保存" }))

    const toggle = await screen.findByRole("switch", { name: "启用 docs" })
    expect(toggle).toHaveAttribute("aria-checked", "false")
    expect(backend.mcpConfigs.docs?.enabled).toBe(false)
    await user.click(toggle)
    await waitFor(() => expect(backend.mcpConfigs.docs?.enabled).toBe(true))

    await user.click(screen.getByRole("button", { name: "删除 docs" }))
    const remove = screen.getByRole("dialog", { name: "删除 MCP docs" })
    await user.click(within(remove).getByRole("button", { name: "确认删除" }))
    await waitFor(() => expect(screen.queryByRole("switch", { name: "启用 docs" })).not.toBeInTheDocument())

    await user.click(screen.getByRole("link", { name: "首页" }))
    await user.click(await screen.findByRole("button", { name: "打开 demo" }))
    expect(await screen.findByRole("complementary", { name: "项目与 Session 导航" }, { timeout: 5_000 })).toBeVisible()
    expect(screen.queryByRole("navigation", { name: "全局管理" })).not.toBeInTheDocument()
    expect(backend.requests.filter((request) => request.path === "/global/management-context")).toHaveLength(1)
  }, 20_000)

  it("completes the desktop Settings journey and returns to the same Session", async () => {
    const user = userEvent.setup()
    const directory = "C:\\work\\demo"
    const desktop = createFakeDesktop({ recentProjects: [{ path: directory, usedAt: 1 }] })
    const backend = createFakeJyycode(desktop.directory)
    backend.addSession({ id: "ses_settings", slug: "settings", title: "Settings Session" })
    vi.stubGlobal("fetch", backend.fetch)

    render(() => <App bridge={desktop.bridge} />)

    await user.click(await screen.findByRole("link", { name: "设置" }, { timeout: 5_000 }))
    expect(await screen.findByRole("heading", { name: "设置" })).toBeVisible()

    await user.click(await screen.findByRole("radio", { name: "启动时显示 Home" }))
    await waitFor(() => expect(desktop.settings().startup).toBe("home"))
    await user.click(screen.getByRole("radio", { name: "浅色" }))
    await waitFor(() => expect(desktop.settings().theme).toBe("light"))
    expect(document.documentElement).toHaveAttribute("data-theme", "light")
    expect(screen.getByRole("combobox", { name: "语言" })).toBeEnabled()
    const glass = screen.getByRole("checkbox", { name: "Apple 风格液态玻璃" })
    expect(glass).toBeEnabled()
    await user.click(glass)
    await waitFor(() => expect(desktop.settings().glass).toBe("on"))
    expect(document.documentElement).toHaveAttribute("data-glass", "on")
    for (const label of ["回复完成", "等待权限", "Agent 提问"]) {
      expect(screen.getByRole("checkbox", { name: label })).toBeEnabled()
    }

    await user.click(screen.getByRole("link", { name: "权限与安全" }))
    expect(await screen.findByText("仅应用于新建的 Session；现有 Session 保留各自的权限选择。")).toBeVisible()
    await user.click(await screen.findByRole("radio", { name: "每次询问" }))
    await waitFor(() => expect(backend.globalConfig().permission).toEqual({ "*": "ask" }))

    await user.click(screen.getByRole("link", { name: "高级" }))
    const shell = await screen.findByRole("combobox", { name: "默认 Shell" })
    await waitFor(() => expect(shell).toBeEnabled())
    await user.selectOptions(shell, "pwsh")
    await waitFor(() => expect(backend.globalConfig().shell).toBe("pwsh"))
    await user.click(screen.getByRole("button", { name: "打开全局配置文件" }))
    await waitFor(() => expect(desktop.bridge.revealConfigFile).toHaveBeenCalledWith("C:\\config\\jyycode.jsonc"))
    expect(screen.getByLabelText("自动更新策略")).toHaveValue("notify")
    expect(screen.getByRole("region", { name: "自动更新" })).toHaveTextContent("已就绪")
    expect(await screen.findByRole("checkbox", { name: "自动压缩" })).toBeChecked()
    expect(screen.getByRole("button", { name: "保存压缩参数" })).toBeDisabled()
    expect(screen.getByRole("heading", { name: "记忆管理" })).toBeVisible()
    await user.click(screen.getByRole("link", { name: /用户记忆/ }))
    expect(await screen.findByRole("heading", { name: "用户记忆" })).toBeVisible()
    expect(screen.getByRole("searchbox", { name: "搜索记忆" })).toBeVisible()
    await user.click(screen.getByRole("button", { name: "返回" }))
    expect(await screen.findByRole("heading", { name: "高级" })).toBeVisible()
    expect(screen.queryByText("即将推出")).not.toBeInTheDocument()

    await user.click(screen.getByRole("button", { name: "返回" }))
    expect(await screen.findByRole("heading", { name: "JYYCode" })).toBeVisible()
    await user.click(screen.getByRole("button", { name: "打开 demo" }))
    expect(await screen.findByRole("complementary", { name: "项目与 Session 导航" }, { timeout: 5_000 })).toBeVisible()
    await user.click(await screen.findByRole("link", { name: /Settings Session/ }))
    expect(await screen.findByRole("heading", { name: "Settings Session" })).toBeVisible()

    await user.click(screen.getByRole("link", { name: "打开设置" }))
    expect(await screen.findByRole("heading", { name: "设置" })).toBeVisible()
    await user.click(screen.getByRole("button", { name: "返回" }))
    expect(await screen.findByRole("heading", { name: "Settings Session" })).toBeVisible()
    expect(desktop.lastLocation()).toEqual({
      project: directory,
      sessionID: "ses_settings",
      openProjects: [{ path: directory, sessionID: "ses_settings" }],
    })
  }, 20_000)

  it("creates, prompts, streams, answers, stops, and restores a single-Agent Session", async () => {
    const user = userEvent.setup()
    const desktop = createFakeDesktop()
    const backend = createFakeJyycode(desktop.directory)
    vi.stubGlobal("fetch", backend.fetch)

    render(() => <App bridge={desktop.bridge} />)
    const createProject = await screen.findByRole("button", { name: /新建项目/ })
    createProject.focus()
    await user.keyboard("{Enter}")
    const chooseParent = screen.getByRole("button", { name: "选择" })
    chooseParent.focus()
    await user.keyboard("{Enter}")
    await user.type(screen.getByRole("textbox", { name: "项目名称" }), "demo")
    const submitProject = screen.getByRole("button", { name: "创建并进入" })
    submitProject.focus()
    await user.keyboard("{Enter}")

    await waitFor(
      () => {
        expect(screen.getByRole("main")).toBeVisible()
        expect(screen.getByRole("combobox", { name: "智能体" })).toHaveValue("build")
        expect(screen.getByRole("button", { name: "配置模型：Test · Test Model" })).toBeVisible()
      },
      { timeout: 5_000 },
    )
    expect(screen.getByRole("switch", { name: "多智能体" })).toHaveAttribute("aria-checked", "false")
    const createSession = backend.requests.find((request) => request.method === "POST" && request.path === "/session")
    expect(createSession?.body).not.toHaveProperty("multiAgent")
    expect(createSession?.body).not.toHaveProperty("title")

    const composer = screen.getByRole("textbox", { name: "消息" })
    await user.type(composer, "保留这段草稿")
    await user.click(screen.getByRole("button", { name: "待办" }))
    await user.click(screen.getByRole("button", { name: "待办" }))
    expect(composer).toHaveValue("保留这段草稿")
    await user.clear(composer)
    await user.type(composer, "检查当前工作区")
    fireEvent.keyDown(composer, { key: "Enter", code: "Enter" })

    expect(await screen.findByText("流式回复已完成")).toBeVisible()
    expect(await screen.findByRole("heading", { name: "检查工作区状态" })).toBeVisible()
    await user.click(screen.getByRole("button", { name: /思考与工具调用/ }))
    expect(screen.getByRole("region", { name: "工具调用：bash" })).toHaveTextContent("检查工作区")
    const handleRequest = await screen.findByRole("button", { name: "处理请求" })
    handleRequest.focus()
    await user.keyboard("{Enter}")
    const allowOnce = screen.getByRole("button", { name: "仅本次允许" })
    expect(allowOnce).toHaveFocus()
    await user.keyboard("{Enter}")
    await waitFor(() => expect(backend.permissions).toHaveLength(0))

    const stop = screen.getByRole("button", { name: "停止" })
    stop.focus()
    await user.keyboard("{Enter}")
    await waitFor(() => expect(screen.getByRole("button", { name: "发送" })).toBeVisible())
    expect(desktop.lastLocation()).toEqual({
      project: desktop.directory,
      sessionID: "ses_1",
      openProjects: [{ path: desktop.directory, sessionID: "ses_1" }],
    })

    cleanup()
    window.history.replaceState(null, "", "/")
    render(() => <App bridge={desktop.bridge} />)

    await waitFor(
      () => {
        expect(screen.getByText("流式回复已完成")).toBeVisible()
        expect(screen.getByText("检查当前工作区")).toBeVisible()
        expect(screen.getByRole("switch", { name: "多智能体" })).toHaveAttribute("aria-checked", "false")
        expect(screen.getByText("后端已连接")).toBeVisible()
        expect(screen.getByRole("button", { name: "返回项目首页" })).toBeVisible()
      },
      { timeout: 5_000 },
    )

    await new Promise((resolve) => window.setTimeout(resolve, 0))
    await user.click(screen.getByRole("button", { name: "返回项目首页" }))
    expect(await screen.findByRole("heading", { name: "JYYCode" })).toBeVisible()
    expect(desktop.lastLocation()).toEqual({})
  })

  it("keeps the workspace mounted while creating and opening a new Session", async () => {
    const user = userEvent.setup()
    const desktop = createFakeDesktop({ lastLocation: { project: "C:\\work\\demo", sessionID: "ses_1" } })
    const backend = createFakeJyycode(desktop.directory)
    backend.sessions.push({
      id: "ses_1",
      slug: "existing",
      projectID: backend.project.id,
      directory: desktop.directory,
      title: "Existing Session",
      version: "test",
      time: { created: 1, updated: 1 },
    })
    backend.messages.set("ses_1", [])
    vi.stubGlobal("fetch", backend.fetch)
    render(() => <App bridge={desktop.bridge} />)

    expect(await screen.findByRole("heading", { name: "Existing Session" }, { timeout: 5_000 })).toBeVisible()
    const loadingFlashes: string[] = []
    const observer = new MutationObserver(() => {
      if (document.body.textContent?.includes("正在加载工作区")) loadingFlashes.push("workspace")
    })
    observer.observe(document.body, { childList: true, subtree: true })

    await user.click(screen.getByRole("button", { name: "新建 Session" }))
    await waitFor(() => expect(screen.getByRole("heading", { name: /^New session/ })).toBeVisible(), { timeout: 5_000 })
    observer.disconnect()

    expect(loadingFlashes).toEqual([])
    expect(screen.getByText("后端已连接")).toBeVisible()
  })

  it("runs the complete Multi-Agent root, child, model, reconnect, and restore journey", async () => {
    const user = userEvent.setup()
    const desktop = createFakeDesktop({ lastLocation: { project: "C:\\work\\demo", sessionID: "ses_root" } })
    const backend = createFakeJyycode(desktop.directory)
    backend.addSession({ id: "ses_root", slug: "root", title: "Root Session" })
    backend.addSession({
      id: "ses_child",
      slug: "child",
      title: "Implement feature",
      parentID: "ses_root",
      agent: "coder",
      model: { providerID: "test", id: "test-complex" },
    })
    vi.stubGlobal("fetch", backend.fetch)
    render(() => <App bridge={desktop.bridge} />)

    expect(await screen.findByRole("heading", { name: "Root Session" }, { timeout: 5_000 })).toBeVisible()
    const mode = screen.getByRole("switch", { name: "多智能体" })
    expect(mode).toHaveAttribute("aria-checked", "false")
    expect(backend.sessions[0]).not.toHaveProperty("multiAgent")
    await user.click(mode)
    await waitFor(() => expect(mode).toHaveAttribute("aria-checked", "true"))
    expect(
      backend.requests.some(
        (request) =>
          request.method === "PATCH" && request.path === "/session/ses_root" && request.body.multiAgent === true,
      ),
    ).toBe(true)

    const draft = screen.getByRole("textbox", { name: "消息" })
    await user.type(draft, "保留根草稿")
    await user.click(screen.getByRole("button", { name: "多智能体" }))
    expect(screen.getByRole("button", { name: "多智能体" })).toHaveAttribute("aria-pressed", "true")

    backend.setAgentCluster("ses_root", clusterSnapshot())
    backend.emitAgentCluster({
      sessionID: "ses_root",
      runID: "run_1",
      taskID: "code",
      type: "task",
      status: "running",
      message: "Started coding",
      createdAt: 3,
    })
    expect(await screen.findByRole("progressbar", { name: "多智能体进度" })).toHaveAttribute("aria-valuenow", "0")
    expect(screen.getByText(/1 TASKS.*1 ACTIVE/)).toBeVisible()

    const railButton = screen.getByRole("button", { name: "多智能体" })
    await user.click(railButton)
    expect(screen.queryByRole("complementary", { name: "Multi-Agent" })).not.toBeInTheDocument()
    expect(draft).toHaveValue("保留根草稿")
    expect(railButton.querySelector(".workspace-activity-button__badge")).toHaveTextContent("1")

    await user.click(railButton)
    await user.click(await screen.findByRole("button", { name: "审阅：Implement feature" }))
    expect(await screen.findByRole("heading", { name: "Implement feature" })).toBeVisible()
    const rootList = screen.getByRole("navigation", { name: "活动 Session" })
    expect(within(rootList).getByRole("link", { name: /Root Session/ })).toHaveAttribute("aria-current", "page")
    const childDraft = screen.getByRole("textbox", { name: "消息" })
    await user.type(childDraft, "请先解释你的修改")
    await user.keyboard("{Enter}")
    await waitFor(() =>
      expect(
        backend.requests.some(
          (request) =>
            request.path === "/session/ses_child/prompt_async" &&
            request.body.agent === "coder" &&
            JSON.stringify(request.body.model) === JSON.stringify({ providerID: "test", modelID: "test-complex" }),
        ),
      ).toBe(true),
    )

    await user.click(screen.getByRole("button", { name: "返回主 Session" }))
    expect(await screen.findByRole("heading", { name: "Root Session" })).toBeVisible()
    expect(screen.getByRole("progressbar", { name: "多智能体进度" })).toBeVisible()
    expect(screen.getByRole("textbox", { name: "消息" })).toHaveValue("保留根草稿")

    await user.click(screen.getByRole("button", { name: /配置模型/ }))
    const modelDialog = screen.getByRole("dialog", { name: "配置模型" })
    const selects = await within(modelDialog).findAllByRole("combobox")
    const modelSelects = selects.filter((select) => !select.closest(".cluster-model-dialog__variant"))
    expect(modelSelects).toHaveLength(4)
    await user.selectOptions(modelSelects[0]!, "test/test-simple")
    await user.selectOptions(modelSelects[1]!, "test/test-planner")
    await user.selectOptions(modelSelects[2]!, "test/test-visual")
    await user.selectOptions(modelSelects[3]!, "test/test-complex")
    await user.click(within(modelDialog).getByRole("button", { name: "保存" }))
    await waitFor(() => expect(modelDialog).not.toHaveAttribute("open"))
    expect(backend.globalConfig().agent_cluster).toMatchObject({
      planner_model: "test/test-simple",
      simple_model: "test/test-planner",
      complex_model: "test/test-visual",
      visual_model: "test/test-complex",
      max_concurrency: 4,
    })

    await user.click(screen.getByRole("switch", { name: "多智能体" }))
    const rootDraft = screen.getByRole("textbox", { name: "消息" })
    await user.clear(rootDraft)
    await user.type(rootDraft, "普通提示")
    await user.click(screen.getByRole("button", { name: "发送" }))
    await waitFor(() =>
      expect(
        backend.requests.some(
          (request) =>
            request.path === "/session/ses_root/prompt_async" &&
            JSON.stringify(request.body.model) === JSON.stringify({ providerID: "test", modelID: "test-simple" }),
        ),
      ).toBe(true),
    )
    await user.click(await screen.findByRole("button", { name: "停止" }))
    await waitFor(() => expect(screen.getByRole("button", { name: "发送" })).toBeVisible())

    await user.click(screen.getByRole("switch", { name: "多智能体" }))
    await user.type(screen.getByRole("textbox", { name: "消息" }), "规划提示")
    await user.click(screen.getByRole("button", { name: "发送" }))
    await waitFor(() => {
      const prompts = backend.requests.filter((request) => request.path === "/session/ses_root/prompt_async")
      expect(prompts.at(-1)?.body.model).toEqual({ providerID: "test", modelID: "test-simple" })
      expect(prompts.at(-1)?.body.agentCluster).toEqual({ enabled: true })
    })
    await user.click(await screen.findByRole("button", { name: "停止" }))

    const beforeReconnect = backend.requests.filter((request) => request.path.endsWith("/agent-cluster")).length
    backend.disconnectStreams()
    expect(await screen.findByText("连接已中断，正在重新连接…")).toBeVisible()
    await waitFor(
      () => {
        expect(screen.getByText("后端已连接")).toBeVisible()
        const after = backend.requests.filter((request) => request.path.endsWith("/agent-cluster")).length
        expect(after).toBe(beforeReconnect + 1)
        expect(screen.getByRole("progressbar", { name: "多智能体进度" })).toBeVisible()
      },
      { timeout: 4_000 },
    )

    await user.click(screen.getByRole("button", { name: "审阅：Implement feature" }))
    await waitFor(() =>
      expect(desktop.lastLocation()).toEqual({
        project: desktop.directory,
        sessionID: "ses_child",
        openProjects: [{ path: desktop.directory, sessionID: "ses_child" }],
      }),
    )
    cleanup()
    window.history.replaceState(null, "", "/")
    render(() => <App bridge={desktop.bridge} />)
    const restoredBack = await screen.findByRole("button", { name: "返回主 Session" }, { timeout: 5_000 })
    expect(screen.queryByRole("button", { name: /当前模型/ })).not.toBeInTheDocument()
    await user.click(restoredBack)
    await waitFor(() => expect(screen.queryByRole("button", { name: "返回主 Session" })).not.toBeInTheDocument())
    expect(screen.getByText("多智能体模式")).toBeVisible()
  }, 25_000)

  it("restores, guides, and returns from a writable child-Agent Session", async () => {
    const user = userEvent.setup()
    const desktop = createFakeDesktop({
      lastLocation: { project: "C:\\work\\demo", sessionID: "ses_child" },
    })
    const backend = createFakeJyycode(desktop.directory)
    backend.addSession({ id: "ses_root", slug: "root", title: "Root Session", time: { created: 1, updated: 1 } })
    backend.addSession({
      id: "ses_child",
      slug: "child",
      title: "Implement feature",
      parentID: "ses_root",
      agent: "coder",
      model: { providerID: "test", id: "coder-model" },
      time: { created: 2, updated: 2 },
    })
    backend.addSession({
      id: "ses_sibling",
      slug: "sibling",
      title: "Research feature",
      parentID: "ses_root",
      agent: "researcher",
      model: { providerID: "test", id: "test-simple" },
      time: { created: 3, updated: 3 },
    })
    backend.setAgentCluster("ses_root", {
      tasks: [
        {
          id: "code",
          session_id: "ses_root",
          origin_message_id: "msg_parent",
          parent_task_id: "",
          child_session_id: "ses_child",
          role: "coder",
          title: "Implement",
          prompt: "Implement",
          complexity: "complex",
          model: "test/coder-model",
          status: "running",
          step: 1,
          dependencies: [],
          review_round: 0,
          acceptance_criteria: [],
          artifact_paths: [],
          result_summary: "",
          review_issues: [],
          last_event: "Started",
          time_created: 2,
          time_updated: 2,
        },
        {
          id: "research",
          session_id: "ses_root",
          origin_message_id: "msg_parent",
          parent_task_id: "",
          child_session_id: "ses_sibling",
          role: "researcher",
          title: "Research",
          prompt: "Research",
          complexity: "simple",
          model: "test/test-simple",
          status: "queued",
          step: 1,
          dependencies: [],
          review_round: 0,
          acceptance_criteria: [],
          artifact_paths: [],
          result_summary: "",
          review_issues: [],
          last_event: "Queued",
          time_created: 3,
          time_updated: 3,
        },
      ],
    })
    backend.permissions.push(
      {
        id: "per_sibling",
        sessionID: "ses_sibling",
        permission: "bash",
        patterns: ["sibling command"],
        metadata: {},
        always: [],
      },
      {
        id: "per_child",
        sessionID: "ses_child",
        permission: "bash",
        patterns: ["child command"],
        metadata: {},
        always: [],
      },
    )
    vi.stubGlobal("fetch", backend.fetch)
    render(() => <App bridge={desktop.bridge} />)

    expect(await screen.findByRole("heading", { name: "Implement feature" }, { timeout: 5_000 })).toBeVisible()
    const sessionList = screen.getByRole("navigation", { name: "活动 Session" })
    expect(within(sessionList).getAllByRole("link")).toHaveLength(1)
    expect(within(sessionList).getByRole("link", { name: /Root Session/ })).toHaveAttribute("aria-current", "page")
    expect(screen.getByRole("button", { name: "返回主 Session" })).toBeVisible()
    expect(screen.getByText(/子智能体 · Coder/)).toBeVisible()
    expect(screen.queryByLabelText("智能体")).not.toBeInTheDocument()
    expect(screen.queryByRole("button", { name: /当前模型/ })).not.toBeInTheDocument()
    expect(screen.getByText("child command")).toBeVisible()
    expect(screen.queryByText("sibling command")).not.toBeInTheDocument()

    await user.type(screen.getByRole("textbox", { name: "消息" }), "请先解释你的修改")
    await user.keyboard("{Enter}")
    await user.click(screen.getByRole("button", { name: "仅本次允许" }))
    await waitFor(() =>
      expect(
        backend.requests.some(
          (request) =>
            request.path === "/session/ses_child/interrupt-prompt" &&
            request.body.agent === "coder" &&
            JSON.stringify(request.body.model) === JSON.stringify({ providerID: "test", modelID: "coder-model" }) &&
            JSON.stringify(request.body.agentCluster) === JSON.stringify({ enabled: false }),
        ),
      ).toBe(true),
      { timeout: 4_000 },
    )
    await waitFor(() =>
      expect(desktop.lastLocation()).toEqual({
        project: desktop.directory,
        sessionID: "ses_child",
        openProjects: [{ path: desktop.directory, sessionID: "ses_child" }],
      }),
    )

    cleanup()
    window.history.replaceState(null, "", "/")
    render(() => <App bridge={desktop.bridge} />)
    expect(await screen.findByRole("button", { name: "返回主 Session" }, { timeout: 5_000 })).toBeVisible()
    expect(screen.queryByLabelText("智能体")).not.toBeInTheDocument()

    await user.click(screen.getByRole("button", { name: "返回主 Session" }))
    expect(await screen.findByRole("heading", { name: "Root Session" })).toBeVisible()
    expect(screen.queryByText("child command")).not.toBeInTheDocument()
  }, 20_000)
})
// @ts-nocheck
