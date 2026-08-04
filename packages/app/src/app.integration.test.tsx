// @ts-nocheck
import { cleanup, fireEvent, render, screen, waitFor, within } from "@solidjs/testing-library"
import type { SessionBlackboardResponse, SessionPlanResponse } from "@jyycode-ai/sdk/v2/client"
import userEvent from "@testing-library/user-event"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { App } from "./app"
import { createFakeDesktop } from "./test/fake-desktop"
import { createFakeJyycode } from "./test/fake-jyycode"

function planSnapshot(): SessionPlanResponse {
  return {
    title: "Implement feature",
    goal: "Implement and verify the feature",
    status: "active",
    revision: 2,
    current_step: "s1",
    pending_review: 0,
    inbox_pending: 0,
    steps: [
      {
        id: "s1",
        title: "Implementation",
        status: "active",
        tasks: [
          {
            id: "s1_t1",
            title: "Implement feature",
            status: "running",
            child: { session_id: "ses_child", elapsed_sec: 1, last_activity: "Started coding" },
          },
        ],
      },
    ],
  }
}

function blackboardSnapshot(rootSessionID: string): SessionBlackboardResponse {
  return {
    rootSessionID,
    currentStepID: "s1",
    selectedStepID: "s1",
    readonly: false,
    tasks: [{ id: "s1_t1", title: "Implement feature", status: "running", hasAgent: true, isSelf: false }],
    messages: [
      {
        id: "bb_child",
        rootSessionID,
        stepID: "s1",
        authorKind: "sub_agent",
        authorTaskID: "s1_t1",
        kind: "blocker",
        body: "Child found a blocker",
        mentions: [],
        attachments: [],
        taskIDs: ["s1_t1"],
        timeCreated: 2,
        replies: [
          { id: "bb_child_reply_1", body: "First follow-up", timeCreated: 3 },
          { id: "bb_child_reply_2", body: "Latest follow-up", timeCreated: 4 },
        ],
      },
    ],
    unreadCount: 2,
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

  it("refreshes the Composer catalog and open Plan after saving a subagent profile", async () => {
    const user = userEvent.setup()
    const desktop = createFakeDesktop({ lastLocation: { project: "C:\\work\\demo", sessionID: "ses_profile" } })
    const backend = createFakeJyycode(desktop.directory)
    backend.addSession({ id: "ses_profile", slug: "profile", title: "Profile Session" })
    vi.stubGlobal("fetch", backend.fetch)
    render(() => <App bridge={desktop.bridge} />)

    expect(await screen.findByRole("heading", { name: "Profile Session" }, { timeout: 5_000 })).toBeVisible()
    await user.click(screen.getByRole("button", { name: "方案" }))
    await user.click(screen.getByRole("button", { name: "子 Agent" }))
    expect(await screen.findByRole("heading", { name: "子 Agent" })).toBeVisible()
    await user.click(await screen.findByRole("button", { name: "新建子 Agent" }))
    await user.type(screen.getByRole("textbox", { name: "角色 ID" }), "reviewer")
    await user.type(screen.getByRole("textbox", { name: "角色名称" }), "Reviewer")
    await user.type(screen.getByRole("textbox", { name: "角色描述" }), "Reviews changes")
    await waitFor(() => expect(screen.getByRole("button", { name: "保存角色" })).toBeEnabled())

    const before = {
      profiles: backend.requests.filter((request) => request.path === "/subagents" && request.method === "GET").length,
      agents: backend.requests.filter((request) => request.path === "/agent").length,
      providers: backend.requests.filter((request) => request.path === "/config/providers").length,
      models: backend.requests.filter((request) => request.path === "/provider").length,
      config: backend.requests.filter((request) => request.path === "/config").length,
      plans: backend.requests.filter((request) => request.path.endsWith("/plan")).length,
    }

    await user.click(screen.getByRole("button", { name: "保存角色" }))
    await waitFor(() =>
      expect(backend.requests.some((request) => request.path === "/subagents" && request.method === "PUT")).toBe(true),
    )
    await waitFor(() => {
      expect(
        backend.requests.filter((request) => request.path === "/subagents" && request.method === "GET").length,
      ).toBeGreaterThan(before.profiles)
      expect(backend.requests.filter((request) => request.path === "/agent").length).toBeGreaterThan(before.agents)
      expect(backend.requests.filter((request) => request.path === "/config/providers").length).toBeGreaterThan(
        before.providers,
      )
      expect(backend.requests.filter((request) => request.path === "/provider").length).toBeGreaterThan(before.models)
      expect(backend.requests.filter((request) => request.path === "/config").length).toBeGreaterThan(before.config)
      expect(backend.requests.filter((request) => request.path.endsWith("/plan")).length).toBeGreaterThan(before.plans)
    })
  }, 20_000)

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
    expect(screen.getByRole("combobox", { name: "语言" })).toBeEnabled()
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
        expect(screen.getByRole("button", { name: "配置模型" })).toBeVisible()
      },
      { timeout: 5_000 },
    )
    expect(screen.getByRole("switch", { name: "多智能体" })).toHaveAttribute("aria-checked", "false")
    const createSession = backend.requests.find((request) => request.method === "POST" && request.path === "/session")
    expect(createSession?.body).not.toHaveProperty("multiAgent")
    expect(createSession?.body).not.toHaveProperty("title")

    const composer = screen.getByRole("textbox", { name: "消息" })
    await user.type(composer, "保留这段草稿")
    await user.click(screen.getByRole("button", { name: "方案" }))
    await user.click(screen.getByRole("button", { name: "方案" }))
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

  it("keeps the blackboard safe for a single-agent Session", async () => {
    const user = userEvent.setup()
    const desktop = createFakeDesktop({ lastLocation: { project: "C:\\work\\demo", sessionID: "ses_single" } })
    const backend = createFakeJyycode(desktop.directory)
    backend.addSession({ id: "ses_single", slug: "single", title: "Single Session" })
    vi.stubGlobal("fetch", backend.fetch)

    render(() => <App bridge={desktop.bridge} />)

    expect(await screen.findByRole("heading", { name: "Single Session" }, { timeout: 5_000 })).toBeVisible()
    await user.click(await screen.findByRole("button", { name: "协作黑板" }))

    const panel = await screen.findByRole("group", { name: "协作黑板" })
    expect(panel).toHaveTextContent("多智能体 Session 才支持协作黑板")
    expect(backend.requests.some((request) => request.path === "/session/ses_single/blackboard")).toBe(false)
  }, 15_000)

  it("waits for a multi-agent plan before querying the blackboard", async () => {
    const user = userEvent.setup()
    const desktop = createFakeDesktop({ lastLocation: { project: "C:\\work\\demo", sessionID: "ses_multi" } })
    const backend = createFakeJyycode(desktop.directory)
    backend.addSession({ id: "ses_multi", slug: "multi", title: "Multi Session" })
    vi.stubGlobal("fetch", backend.fetch)

    render(() => <App bridge={desktop.bridge} />)

    const mode = await screen.findByRole("switch", { name: "多智能体" }, { timeout: 5_000 })
    await user.click(mode)
    await waitFor(() => expect(mode).toHaveAttribute("aria-checked", "true"))
    await user.click(await screen.findByRole("button", { name: "协作黑板" }))

    const panel = await screen.findByRole("group", { name: "协作黑板" })
    expect(panel).toHaveTextContent("正在等待主智能体生成方案")
    expect(backend.requests.some((request) => request.path === "/session/ses_multi/blackboard")).toBe(false)
  }, 15_000)

  it("keeps the blackboard readable after a multi-agent plan is complete", async () => {
    const user = userEvent.setup()
    const desktop = createFakeDesktop({ lastLocation: { project: "C:\\work\\demo", sessionID: "ses_done" } })
    const backend = createFakeJyycode(desktop.directory)
    backend.addSession({ id: "ses_done", slug: "done", title: "Completed Multi-Agent Session", multiAgent: true })
    const completedPlan = planSnapshot()
    backend.setPlan("ses_done", {
      ...completedPlan,
      status: "done",
      current_step: null as unknown as string,
      steps: completedPlan.steps.map((step) => ({
        ...step,
        status: "done",
        tasks: step.tasks.map((task) => ({ ...task, status: "approved" })),
      })),
    })
    backend.setBlackboard("ses_done", {
      ...blackboardSnapshot("ses_done"),
      currentStepID: "",
      readonly: true,
      unreadCount: 0,
    })
    vi.stubGlobal("fetch", backend.fetch)

    render(() => <App bridge={desktop.bridge} />)

    expect(
      await screen.findByRole("heading", { name: "Completed Multi-Agent Session" }, { timeout: 5_000 }),
    ).toBeVisible()
    await user.click(await screen.findByRole("button", { name: "协作黑板" }))

    const panel = await screen.findByRole("group", { name: "协作黑板" })
    await waitFor(() => expect(panel).toHaveTextContent("Child found a blocker"))
    expect(panel).toHaveTextContent("历史 Step 只读")
    expect(panel).not.toHaveTextContent("Unexpected server error")
    expect(backend.requests.some((request) => request.path === "/session/ses_done/blackboard")).toBe(true)
  }, 15_000)

  it("keeps blackboard content visible but read-only after switching to single-agent mode", async () => {
    const user = userEvent.setup()
    const desktop = createFakeDesktop({ lastLocation: { project: "C:\\work\\demo", sessionID: "ses_toggle" } })
    const backend = createFakeJyycode(desktop.directory)
    backend.addSession({ id: "ses_toggle", slug: "toggle", title: "Toggle Session", multiAgent: true })
    backend.setPlan("ses_toggle", planSnapshot())
    backend.setBlackboard("ses_toggle", blackboardSnapshot("ses_toggle"))
    vi.stubGlobal("fetch", backend.fetch)

    render(() => <App bridge={desktop.bridge} />)

    expect(await screen.findByRole("heading", { name: "Toggle Session" }, { timeout: 5_000 })).toBeVisible()
    await user.click(await screen.findByRole("button", { name: "协作黑板" }))
    await waitFor(() =>
      expect(screen.getByRole("group", { name: "协作黑板" })).toHaveTextContent("Child found a blocker"),
    )
    expect(screen.getByRole("textbox", { name: "发送黑板消息…" })).toBeVisible()

    const mode = screen.getByRole("switch", { name: "多智能体" })
    await user.click(mode)
    await waitFor(() => expect(mode).toHaveAttribute("aria-checked", "false"))

    const panel = screen.getByRole("group", { name: "协作黑板" })
    expect(panel).toHaveTextContent("Child found a blocker")
    expect(panel).toHaveTextContent("单智能体模式下黑板只读")
    expect(panel).not.toHaveTextContent("多智能体 Session 才支持协作黑板")
    expect(screen.queryByRole("textbox", { name: "发送黑板消息…" })).not.toBeInTheDocument()
  }, 15_000)

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
      agent: "worker",
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
    await user.click(screen.getByRole("button", { name: "方案" }))
    expect(screen.getByRole("button", { name: "方案" })).toHaveAttribute("aria-pressed", "true")

    backend.setPlan("ses_root", planSnapshot())
    backend.emitPlan({
      seq: 1,
      type: "child.activity",
      session_id: "ses_root",
      at: new Date(3).toISOString(),
      payload: { taskId: "s1_t1" },
    })
    expect(await screen.findByRole("progressbar", { name: "方案进度" })).toHaveAttribute("aria-valuenow", "0")
    const taskCounts = document.querySelector(".multi-agent-panel__counts")
    await waitFor(() => expect(taskCounts).toHaveTextContent(/1 (?:TASKS|任务).*1 (?:ACTIVE|进行中)/i))

    const railButton = screen.getByRole("button", { name: "方案" })
    await user.click(railButton)
    expect(screen.queryByRole("complementary", { name: "Multi-Agent" })).not.toBeInTheDocument()
    expect(draft).toHaveValue("保留根草稿")
    expect(railButton.querySelector(".workspace-activity-button__badge")).toHaveTextContent("1")

    await user.click(railButton)
    await user.click(await screen.findByRole("button", { name: "审阅：Implement feature" }))
    expect(await screen.findByRole("heading", { name: "Implement feature" })).toBeVisible()
    const rootList = screen.getByRole("navigation", { name: "活动 Session" })
    expect(within(rootList).getByRole("link", { name: /Root Session/ })).toHaveAttribute("aria-current", "page")
    await user.click(screen.getByRole("button", { name: "返回主 Session" }))
    expect(await screen.findByRole("heading", { name: "Root Session" })).toBeVisible()
    expect(screen.getByRole("progressbar", { name: "方案进度" })).toBeVisible()
    expect(screen.getByRole("textbox", { name: "消息" })).toHaveValue("保留根草稿")

    await user.click(screen.getByRole("button", { name: "配置模型" }))
    await user.selectOptions(screen.getByRole("combobox", { name: "模型" }), "test/test-simple")
    await user.click(screen.getByRole("button", { name: "完成" }))

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
    })
    await user.click(await screen.findByRole("button", { name: "停止" }))

    const beforeReconnect = backend.requests.filter((request) => request.path.endsWith("/plan")).length
    backend.disconnectStreams()
    expect(await screen.findByText("连接已中断，正在重新连接…")).toBeVisible()
    await waitFor(
      () => {
        expect(screen.getByText("后端已连接")).toBeVisible()
        const after = backend.requests.filter((request) => request.path.endsWith("/plan")).length
        expect(after).toBe(beforeReconnect + 1)
        expect(screen.getByRole("progressbar", { name: "方案进度" })).toBeVisible()
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
    expect(screen.queryByRole("button", { name: "配置模型" })).not.toBeInTheDocument()
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
      agent: "worker",
      model: { providerID: "test", id: "worker-model" },
      time: { created: 2, updated: 2 },
    })
    backend.addSession({
      id: "ses_sibling",
      slug: "sibling",
      title: "Research feature",
      parentID: "ses_root",
      agent: "investigator",
      model: { providerID: "test", id: "test-simple" },
      time: { created: 3, updated: 3 },
    })
    backend.setPlan("ses_root", {
      title: "Feature work",
      goal: "Implement and research",
      status: "active",
      revision: 2,
      current_step: "s1",
      pending_review: 0,
      inbox_pending: 0,
      steps: [
        {
          id: "s1",
          title: "Work",
          status: "active",
          tasks: [
            {
              id: "s1_t1",
              title: "Implement",
              status: "running",
              role: { id: "worker", name: "Worker", description: "Implementation work", avatar: "code" },
              child: { session_id: "ses_child", elapsed_sec: 1 },
            },
            {
              id: "s1_t2",
              title: "Research",
              status: "dispatched",
              child: { session_id: "ses_sibling", elapsed_sec: 0 },
            },
          ],
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
    expect(screen.getByText(/子智能体/)).toBeVisible()
    expect(screen.queryByLabelText("智能体")).not.toBeInTheDocument()
    expect(screen.queryByRole("button", { name: "配置模型" })).not.toBeInTheDocument()
    expect(screen.getByText("child command")).toBeVisible()
    expect(screen.queryByText("sibling command")).not.toBeInTheDocument()
    expect(await screen.findByRole("button", { name: "发送并中断" })).toBeVisible()
    await user.click(screen.getByRole("button", { name: "仅本次允许" }))
    await waitFor(() => expect(backend.permissions.some((permission) => permission.id === "per_child")).toBe(false))
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

  it("keeps one root-scoped blackboard visible across root and child Sessions", async () => {
    const user = userEvent.setup()
    const desktop = createFakeDesktop({ lastLocation: { project: "C:\\work\\demo", sessionID: "ses_root" } })
    const backend = createFakeJyycode(desktop.directory)
    backend.addSession({ id: "ses_root", slug: "root", title: "Root Session", multiAgent: true })
    backend.addSession({
      id: "ses_child",
      slug: "child",
      title: "Implement feature",
      parentID: "ses_root",
      agent: "worker",
      model: { providerID: "test", id: "test-complex" },
    })
    backend.setPlan("ses_root", planSnapshot())
    backend.setBlackboard("ses_root", blackboardSnapshot("ses_root"))
    vi.stubGlobal("fetch", backend.fetch)

    render(() => <App bridge={desktop.bridge} />)

    expect(await screen.findByRole("heading", { name: "Root Session" }, { timeout: 5_000 })).toBeVisible()
    const blackboardButton = await screen.findByRole("button", { name: "协作黑板" })
    await waitFor(() =>
      expect(blackboardButton.querySelector(".workspace-activity-button__badge")).toHaveTextContent("2"),
    )
    await user.click(blackboardButton)

    const panel = await screen.findByRole("group", { name: "协作黑板" })
    expect(panel).toHaveTextContent("Child found a blocker")
    expect(panel).toHaveTextContent("Implement feature")
    await waitFor(() =>
      expect(blackboardButton.querySelector(".workspace-activity-button__badge")).not.toBeInTheDocument(),
    )
    expect(
      [...backend.requests].reverse().find((request) => request.path === "/session/ses_root/blackboard/read")?.body
        .throughMessageID,
    ).toBe("bb_child_reply_2")
    const rootBlackboardGets = () =>
      backend.requests.filter((request) => request.method === "GET" && request.path === "/session/ses_root/blackboard")
    expect(rootBlackboardGets().length).toBeGreaterThan(0)
    expect(backend.requests.some((request) => request.path === "/session/ses_child/blackboard")).toBe(false)

    await user.click(screen.getByRole("button", { name: "方案" }))
    await user.click(await screen.findByRole("button", { name: "审阅：Implement feature" }))
    expect(await screen.findByRole("heading", { name: "Implement feature" })).toBeVisible()
    expect(screen.getByRole("group", { name: "协作黑板" })).toHaveTextContent("Child found a blocker")
    expect(backend.requests.some((request) => request.path === "/session/ses_child/blackboard")).toBe(false)
  }, 15_000)
})
// @ts-nocheck
