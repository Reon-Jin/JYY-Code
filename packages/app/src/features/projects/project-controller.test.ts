import type { Project, Session } from "@jyycode-ai/sdk/v2/client"
import { beforeEach, describe, expect, it, vi } from "vitest"
import type { DesktopClient } from "../../data/sdk"
import type { DesktopBridge } from "../../platform/types"
import { createProjectController, GitInitializationError } from "./project-controller"
import { defaultDesktopSettings } from "../settings/settings-preferences"

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

function createHarness() {
  const calls: string[] = []
  const bridge: DesktopBridge = {
    bootstrap: vi.fn(),
    restartBackend: vi.fn(),
    chooseDirectory: vi.fn(),
    createProjectDirectory: vi.fn(async () => {
      calls.push("createProjectDirectory")
      return project.worktree
    }),
    loadRecentProjects: vi.fn(async () => []),
    saveRecentProjects: vi.fn(async () => undefined),
    loadLastLocation: vi.fn(async () => ({})),
    saveLastLocation: vi.fn(async () => undefined),
    loadSettings: vi.fn(async () => defaultDesktopSettings),
    saveSettings: vi.fn(async () => undefined),
    requestNotificationPermission: vi.fn(),
    sendNotification: vi.fn(),
    checkForUpdate: vi.fn(),
    installAvailableUpdate: vi.fn(),
    saveTextFile: vi.fn(),
    revealConfigFile: vi.fn(async () => undefined),
  }
  const sdk = {
    project: {
      current: vi.fn(async () => {
        calls.push("project.current")
        return { data: project }
      }),
      initGit: vi.fn(async () => {
        calls.push("project.initGit")
        return { data: { ...project, vcs: "git" as const } }
      }),
    },
    session: {
      create: vi.fn(async () => {
        calls.push("session.create")
        return { data: session }
      }),
    },
  }
  const controller = createProjectController({
    bridge,
    clientFor: () => sdk as unknown as DesktopClient,
    now: () => 42,
  })

  return { bridge, calls, controller, sdk }
}

describe("project controller", () => {
  beforeEach(() => vi.clearAllMocks())

  it("persists a project only after project.current succeeds", async () => {
    const { bridge, controller } = createHarness()

    const opened = await controller.openProject(project.worktree)

    expect(opened.info.id).toBe("p1")
    expect(controller.openProjects().map((item) => item.directory)).toEqual([project.worktree])
    expect(bridge.saveRecentProjects).toHaveBeenCalledOnce()
    expect(bridge.saveRecentProjects).toHaveBeenCalledWith([{ path: project.worktree, usedAt: 42 }])
  })

  it("remembers the active Session per project and reuses an already-open project", async () => {
    const { controller, sdk } = createHarness()
    const opened = await controller.openProject(project.worktree)

    controller.rememberSession(project.worktree, "ses_demo")
    controller.rememberSession("C:/work/other/", "ses_other")
    const reopened = await controller.openProject("C:/work/demo/")

    expect(controller.sessionFor("C:\\work\\demo")).toBe("ses_demo")
    expect(controller.sessionFor("C:\\work\\other")).toBe("ses_other")
    expect(reopened).toBe(opened)
    expect(sdk.project.current).toHaveBeenCalledOnce()
  })

  it("reorders open projects and selects an adjacent project when the active one closes", async () => {
    const { controller } = createHarness()
    const demo = project.worktree
    const other = "C:\\work\\other"
    const third = "C:\\work\\third"
    await controller.openProject(demo)
    await controller.openProject(other)
    await controller.openProject(third)

    controller.reorderProjects(third, demo, "before")
    expect(controller.openProjects().map((item) => item.directory)).toEqual([third, demo, other])

    expect(controller.closeProject(third)?.directory).toBe(demo)
    expect(controller.openProjects().map((item) => item.directory)).toEqual([demo, other])
    expect(controller.closeProject(other)?.directory).toBe(demo)
    expect(controller.closeProject(demo)).toBeUndefined()
    expect(controller.openProjects()).toEqual([])
  })

  it("creates the directory before asking the backend to initialize git", async () => {
    const { calls, controller, sdk } = createHarness()

    await controller.createProject({ parent: "C:\\work", name: "demo", initGit: true })

    expect(calls).toEqual(["createProjectDirectory", "project.current", "project.initGit", "session.create"])
    expect(sdk.session.create).toHaveBeenCalledWith({ directory: project.worktree }, { throwOnError: true })
  })

  it("does not persist a failed project open", async () => {
    const { bridge, controller, sdk } = createHarness()
    sdk.project.current.mockRejectedValueOnce(new Error("not a project"))

    await expect(controller.openProject("C:\\bad")).rejects.toThrow("not a project")

    expect(bridge.saveRecentProjects).not.toHaveBeenCalled()
  })

  it("returns to project selection and clears the restored location", async () => {
    const { bridge, controller } = createHarness()
    await controller.openProject(project.worktree)

    await controller.returnToProjectSelection()

    expect(controller.activeProject()).toBeUndefined()
    expect(bridge.saveLastLocation).toHaveBeenCalledWith({})
  })

  it("keeps an opened project when Git initialization fails and resumes without recreating the directory", async () => {
    const { bridge, calls, controller, sdk } = createHarness()
    sdk.project.initGit.mockImplementationOnce(async () => {
      calls.push("project.initGit")
      throw new Error("git unavailable")
    })

    let failure: GitInitializationError | undefined
    try {
      await controller.createProject({ parent: "C:\\work", name: "demo", initGit: true })
    } catch (error) {
      failure = error as GitInitializationError
    }

    expect(failure).toBeInstanceOf(GitInitializationError)
    expect(controller.activeProject()?.directory).toBe(project.worktree)
    expect(bridge.saveRecentProjects).toHaveBeenCalledOnce()
    await controller.continueAfterGitFailure(failure!)
    expect(calls).toEqual([
      "createProjectDirectory",
      "project.current",
      "project.initGit",
      "project.initGit",
      "session.create",
    ])
    expect(bridge.createProjectDirectory).toHaveBeenCalledOnce()
  })
})
