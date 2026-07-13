import type { Project, Session } from "@jyycode-ai/sdk/v2/client"
import { createSignal } from "solid-js"
import { createDesktopClient, type DesktopClient } from "../../data/sdk"
import { normalizeRecentProjects, touchRecentProject } from "../../platform/recent-projects"
import type { DesktopBootstrap, DesktopBridge, RecentProject } from "../../platform/types"

export type OpenedProject = {
  directory: string
  info: Project
  client: DesktopClient
}

export type CreatedProject = OpenedProject & {
  session: Session
}

export type CreateProjectInput = {
  parent: string
  name: string
  initGit: boolean
}

export type ProjectControllerInput = {
  bridge: DesktopBridge
  bootstrap?: DesktopBootstrap
  clientFor?: (directory: string) => DesktopClient
  now?: () => number
}

export class GitInitializationError extends Error {
  readonly opened: OpenedProject
  readonly originalError: unknown

  constructor(opened: OpenedProject, originalError: unknown) {
    super("Git 初始化失败")
    this.name = "GitInitializationError"
    this.opened = opened
    this.originalError = originalError
  }
}

function pathKey(path: string) {
  return path.replaceAll("/", "\\").replace(/\\+$/, "").toLocaleLowerCase("en-US")
}

export function errorMessage(error: unknown, fallback = "操作失败") {
  return error instanceof Error && error.message.trim() ? error.message : fallback
}

export function createProjectController(input: ProjectControllerInput) {
  const clientFor =
    input.clientFor ??
    ((directory: string) => {
      if (!input.bootstrap) throw new Error("桌面后端尚未启动")
      return createDesktopClient(input.bootstrap, directory)
    })
  const now = input.now ?? Date.now
  const [activeProject, setActiveProject] = createSignal<OpenedProject>()
  const [recentProjects, setRecentProjects] = createSignal<RecentProject[]>([])
  const [unavailableProjectKeys, setUnavailableProjectKeys] = createSignal<ReadonlySet<string>>(new Set())
  let recentProjectsPromise: Promise<RecentProject[]> | undefined

  async function loadRecentProjects() {
    recentProjectsPromise ??= input.bridge
      .loadRecentProjects()
      .then((projects) => {
        const normalized = normalizeRecentProjects(projects)
        setRecentProjects(normalized)
        return normalized
      })
      .catch((error) => {
        recentProjectsPromise = undefined
        throw error
      })
    return recentProjectsPromise
  }

  function markUnavailable(directory: string, unavailable: boolean) {
    const key = pathKey(directory)
    setUnavailableProjectKeys((current) => {
      const next = new Set(current)
      if (unavailable) next.add(key)
      else next.delete(key)
      return next
    })
  }

  async function persistRecent(directory: string) {
    const current = await loadRecentProjects()
    const next = touchRecentProject(current, directory, now())
    await input.bridge.saveRecentProjects(next)
    setRecentProjects(next)
    return next
  }

  async function openProject(directory: string): Promise<OpenedProject> {
    const client = clientFor(directory)
    let result: Awaited<ReturnType<DesktopClient["project"]["current"]>>
    try {
      result = await client.project.current({ directory }, { throwOnError: true })
    } catch (error) {
      markUnavailable(directory, true)
      throw error
    }
    if (!result.data) {
      markUnavailable(directory, true)
      throw new Error("项目后端未返回项目信息")
    }

    const opened = { directory, info: result.data, client }
    await persistRecent(directory)
    markUnavailable(directory, false)
    setActiveProject(opened)
    return opened
  }

  async function createInitialSession(opened: OpenedProject): Promise<CreatedProject> {
    const result = await opened.client.session.create(
      { directory: opened.directory, multiAgent: false },
      { throwOnError: true },
    )
    if (!result.data) throw new Error("创建 Session 失败")
    return { ...opened, session: result.data }
  }

  async function createProject(inputValue: CreateProjectInput): Promise<CreatedProject> {
    const directory = await input.bridge.createProjectDirectory(inputValue.parent, inputValue.name)
    const opened = await openProject(directory)
    if (inputValue.initGit) {
      try {
        await opened.client.project.initGit({ directory }, { throwOnError: true })
      } catch (error) {
        throw new GitInitializationError(opened, error)
      }
    }
    return createInitialSession(opened)
  }

  async function continueAfterGitFailure(error: GitInitializationError) {
    await error.opened.client.project.initGit(
      { directory: error.opened.directory },
      { throwOnError: true },
    )
    return createInitialSession(error.opened)
  }

  async function chooseAndOpenProject() {
    const directory = await input.bridge.chooseDirectory()
    if (!directory) return undefined
    return openProject(directory)
  }

  async function removeRecentProject(directory: string) {
    const current = await loadRecentProjects()
    const key = pathKey(directory)
    const next = current.filter((project) => pathKey(project.path) !== key)
    await input.bridge.saveRecentProjects(next)
    setRecentProjects(next)
    markUnavailable(directory, false)
  }

  return {
    activeProject,
    recentProjects,
    unavailableProjectKeys,
    isUnavailable: (directory: string) => unavailableProjectKeys().has(pathKey(directory)),
    loadRecentProjects,
    chooseDirectory: () => input.bridge.chooseDirectory(),
    chooseAndOpenProject,
    openProject,
    createProject,
    continueAfterGitFailure,
    removeRecentProject,
  }
}

export type ProjectController = ReturnType<typeof createProjectController>
