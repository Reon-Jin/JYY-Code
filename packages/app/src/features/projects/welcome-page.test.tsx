import type { Project, Session } from "@jyycode-ai/sdk/v2/client"
import { MemoryRouter, Route, useParams } from "@solidjs/router"
import { cleanup, fireEvent, render, screen, waitFor } from "@solidjs/testing-library"
import userEvent from "@testing-library/user-event"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { DesktopClient } from "../../data/sdk"
import type { DesktopBridge } from "../../platform/types"
import { createProjectController } from "./project-controller"
import { ProjectProvider } from "./project-context"
import { WelcomePage } from "./welcome-page"

const project: Project = {
  id: "p1",
  worktree: "C:\\work\\demo",
  time: { created: 1, updated: 1 },
  sandboxes: [],
}

const session: Session = {
  id: "s1",
  slug: "new-session",
  projectID: project.id,
  directory: project.worktree,
  title: "New session",
  version: "test",
  time: { created: 1, updated: 1 },
}

function SessionResult() {
  const params = useParams<{ sessionID: string }>()
  return <h1>Session {params.sessionID}</h1>
}

function createHarness(options?: { gitError?: Error; openError?: Error; recentPath?: string }) {
  const bridge: DesktopBridge = {
    bootstrap: vi.fn(),
    restartBackend: vi.fn(),
    chooseDirectory: vi.fn(async () => project.worktree),
    createProjectDirectory: vi.fn(async () => project.worktree),
    loadRecentProjects: vi.fn(async () =>
      options?.recentPath ? [{ path: options.recentPath, usedAt: 1 }] : [],
    ),
    saveRecentProjects: vi.fn(async () => undefined),
    loadLastLocation: vi.fn(async () => ({})),
    saveLastLocation: vi.fn(async () => undefined),
  }
  const sdk = {
    project: {
      current: options?.openError
        ? vi.fn(async () => Promise.reject(options.openError))
        : vi.fn(async () => ({ data: project })),
      initGit: options?.gitError
        ? vi
            .fn()
            .mockRejectedValueOnce(options.gitError)
            .mockResolvedValue({ data: { ...project, vcs: "git" as const } })
        : vi.fn(async () => ({ data: { ...project, vcs: "git" as const } })),
    },
    session: {
      create: vi.fn(async () => ({ data: session })),
    },
  }
  const controller = createProjectController({
    bridge,
    clientFor: () => sdk as unknown as DesktopClient,
  })

  render(() => (
    <ProjectProvider controller={controller}>
      <MemoryRouter>
        <Route path="/" component={WelcomePage} />
        <Route path="/session/:sessionID" component={SessionResult} />
      </MemoryRouter>
    </ProjectProvider>
  ))

  return { bridge, controller, sdk }
}

describe("WelcomePage", () => {
  afterEach(cleanup)

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
  })

  it("opens an existing directory using the keyboard", async () => {
    const user = userEvent.setup()
    const { bridge, sdk } = createHarness()
    const open = screen.getByRole("button", { name: /打开现有目录/ })

    open.focus()
    await user.keyboard("{Enter}")

    await waitFor(() => expect(sdk.project.current).toHaveBeenCalledOnce())
    expect(bridge.chooseDirectory).toHaveBeenCalledOnce()
  })

  it("shows project errors as an alert", async () => {
    const user = userEvent.setup()
    createHarness({ openError: new Error("目录不存在") })
    const open = screen.getByRole("button", { name: /打开现有目录/ })

    open.focus()
    await user.keyboard("{Enter}")

    expect(await screen.findByRole("alert")).toHaveTextContent("目录不存在")
  })

  it("returns focus to the new-project trigger when the dialog is cancelled", async () => {
    const user = userEvent.setup()
    createHarness()
    const trigger = screen.getByRole("button", { name: /新建项目/ })
    trigger.focus()
    await user.keyboard("{Enter}")
    const dialog = screen.getByRole("dialog", { name: "新建项目" })

    fireEvent(dialog, new Event("cancel", { cancelable: true }))

    await waitFor(() => expect(trigger).toHaveFocus())
  })

  it("creates a project with the keyboard and navigates to its Session", async () => {
    const user = userEvent.setup()
    const { bridge } = createHarness()
    const trigger = screen.getByRole("button", { name: /新建项目/ })
    trigger.focus()
    await user.keyboard("{Enter}")

    const choose = screen.getByRole("button", { name: "选择" })
    choose.focus()
    await user.keyboard("{Enter}")
    const name = screen.getByRole("textbox", { name: "项目名称" })
    await user.type(name, "demo")
    const create = screen.getByRole("button", { name: "创建并进入" })
    create.focus()
    await user.keyboard("{Enter}")

    expect(await screen.findByRole("heading", { name: "Session s1" })).toBeVisible()
    expect(bridge.createProjectDirectory).toHaveBeenCalledWith(project.worktree, "demo")
  })

  it("focuses the first invalid field without clearing entered values", async () => {
    const user = userEvent.setup()
    createHarness()
    const trigger = screen.getByRole("button", { name: /新建项目/ })
    trigger.focus()
    await user.keyboard("{Enter}")
    const name = screen.getByRole("textbox", { name: "项目名称" })
    await user.type(name, "kept-name")
    const create = screen.getByRole("button", { name: "创建并进入" })
    create.focus()
    await user.keyboard("{Enter}")

    expect(await screen.findByRole("alert")).toHaveTextContent("请选择父目录")
    expect(screen.getByRole("textbox", { name: "父目录" })).toHaveFocus()
    expect(name).toHaveValue("kept-name")
  })

  it("keeps a missing recent project visible until it is explicitly removed", async () => {
    const user = userEvent.setup()
    const path = "C:\\missing"
    createHarness({ openError: new Error("目录不存在"), recentPath: path })
    const recent = (await screen.findByText(path)).closest("button")
    expect(recent).not.toBeNull()

    await user.click(recent!)

    expect(await screen.findByText("不可用")).toBeVisible()
    expect(screen.getByText(path)).toBeVisible()
    await user.click(screen.getByRole("button", { name: `从最近项目中移除 ${path}` }))
    expect(screen.queryByText(path)).not.toBeInTheDocument()
  })

  it("offers an inline Git retry without creating the directory again", async () => {
    const user = userEvent.setup()
    const { bridge } = createHarness({ gitError: new Error("git unavailable") })
    await user.click(screen.getByRole("button", { name: /新建项目/ }))
    await user.click(screen.getByRole("button", { name: "选择" }))
    await user.type(screen.getByRole("textbox", { name: "项目名称" }), "demo")
    await user.click(screen.getByRole("button", { name: "创建并进入" }))

    expect(await screen.findByRole("alert")).toHaveTextContent("Git 初始化失败")
    await user.click(screen.getByRole("button", { name: "重试初始化 Git" }))

    expect(await screen.findByRole("heading", { name: "Session s1" })).toBeVisible()
    expect(bridge.createProjectDirectory).toHaveBeenCalledOnce()
  })
})
