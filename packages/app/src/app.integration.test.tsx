import { cleanup, fireEvent, render, screen, waitFor, within } from "@solidjs/testing-library"
import userEvent from "@testing-library/user-event"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { App } from "./app"
import { createFakeDesktop } from "./test/fake-desktop"
import { createFakeJyycode } from "./test/fake-jyycode"

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
        expect(screen.getByRole("combobox", { name: "Agent" })).toHaveValue("build")
        expect(screen.getByRole("combobox", { name: "模型" })).toHaveValue("test/test-model")
      },
      { timeout: 5_000 },
    )
    expect(screen.getByRole("switch", { name: "Multi-Agent" })).toHaveAttribute("aria-checked", "false")
    const createSession = backend.requests.find((request) => request.method === "POST" && request.path === "/session")
    expect(createSession?.body).not.toHaveProperty("multiAgent")
    expect(createSession?.body).not.toHaveProperty("title")

    const composer = screen.getByRole("textbox", { name: "消息" })
    await user.type(composer, "保留这段草稿")
    await user.click(screen.getByRole("button", { name: "Todo" }))
    await user.click(screen.getByRole("button", { name: "Todo" }))
    expect(composer).toHaveValue("保留这段草稿")
    await user.clear(composer)
    await user.type(composer, "检查当前工作区")
    fireEvent.keyDown(composer, { key: "Enter", code: "Enter" })

    expect(await screen.findByText("流式回复已完成")).toBeVisible()
    expect(await screen.findByRole("heading", { name: "检查工作区状态" })).toBeVisible()
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
    expect(desktop.lastLocation()).toEqual({ project: desktop.directory, sessionID: "ses_1" })

    cleanup()
    window.history.replaceState(null, "", "/")
    render(() => <App bridge={desktop.bridge} />)

    await waitFor(
      () => {
        expect(screen.getByText("流式回复已完成")).toBeVisible()
        expect(screen.getByText("检查当前工作区")).toBeVisible()
        expect(screen.getByRole("switch", { name: "Multi-Agent" })).toHaveAttribute("aria-checked", "false")
        expect(screen.getByText("后端已连接")).toBeVisible()
        expect(screen.getByRole("button", { name: "返回项目首页" })).toBeVisible()
      },
      { timeout: 5_000 },
    )

    await new Promise((resolve) => window.setTimeout(resolve, 0))
    await user.click(screen.getByRole("button", { name: "返回项目首页" }))
    expect(await screen.findByRole("heading", { name: /让代码保持流动/ })).toBeVisible()
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
      runs: [
        {
          id: "run_1",
          session_id: "ses_root",
          parent_message_id: "msg_parent",
          enabled: true,
          status: "dispatching",
          goal: "Implement the feature",
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
          run_id: "run_1",
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
    expect(screen.getByText(/子 Agent · Coder/)).toBeVisible()
    expect(screen.getByLabelText("Agent")).toHaveValue("coder")
    expect(screen.getByLabelText("Agent")).toBeDisabled()
    expect(screen.getByLabelText("模型")).toHaveValue("test/coder-model")
    expect(screen.getByLabelText("模型")).toBeDisabled()
    expect(screen.getByText("child command")).toBeVisible()
    expect(screen.queryByText("sibling command")).not.toBeInTheDocument()

    await user.type(screen.getByRole("textbox", { name: "消息" }), "请先解释你的修改")
    await user.click(screen.getByRole("button", { name: "发送" }))
    await waitFor(() =>
      expect(
        backend.requests.some(
          (request) =>
            request.path === "/session/ses_child/prompt_async" &&
            request.body.agent === "coder" &&
            JSON.stringify(request.body.model) === JSON.stringify({ providerID: "test", modelID: "coder-model" }),
        ),
      ).toBe(true),
    )
    await waitFor(() => expect(desktop.lastLocation()).toEqual({ project: desktop.directory, sessionID: "ses_child" }))

    cleanup()
    window.history.replaceState(null, "", "/")
    render(() => <App bridge={desktop.bridge} />)
    expect(await screen.findByRole("button", { name: "返回主 Session" }, { timeout: 5_000 })).toBeVisible()
    expect(screen.getByLabelText("Agent")).toHaveValue("coder")

    await user.click(screen.getByRole("button", { name: "返回主 Session" }))
    expect(await screen.findByRole("heading", { name: "Root Session" })).toBeVisible()
    expect(screen.getByText("来自子 Agent · Coder")).toBeVisible()
    expect(screen.getByText("child command")).toBeVisible()
  }, 20_000)
})
