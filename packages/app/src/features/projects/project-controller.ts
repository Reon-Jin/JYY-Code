import type { Project, Session } from "@jyycode-ai/sdk/v2/client"
import { createSignal } from "solid-js"
import { createDesktopClient, type DesktopClient } from "../../data/sdk"
import { normalizeRecentProjects, touchRecentProject } from "../../platform/recent-projects"
import { normalizeDirectory } from "../../platform/desktop-path"
import { tr } from "../../i18n/i18n-context"
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
    super(tr("projects.git-initialization-failed-title"))
    this.name = "GitInitializationError"
    this.opened = opened
    this.originalError = originalError
  }
}

function pathKey(path: string) {
  return normalizeDirectory(path)
}

export function errorMessage(error: unknown, fallback = tr("projects.operation-failed")) {
  return error instanceof Error && error.message.trim() ? error.message : fallback
}

export function createProjectController(input: ProjectControllerInput) {
  const clientFor =
    input.clientFor ??
    ((directory: string) => {
      if (!input.bootstrap) throw new Error(tr("projects.desktop-backend-not-started"))
      return createDesktopClient(input.bootstrap, directory)
    })
  const now = input.now ?? Date.now
  const [activeProject, setActiveProject] = createSignal<OpenedProject>()
  const [openProjects, setOpenProjects] = createSignal<OpenedProject[]>([])
  const [recentProjects, setRecentProjects] = createSignal<RecentProject[]>([])
  const [unavailableProjectKeys, setUnavailableProjectKeys] = createSignal<ReadonlySet<string>>(new Set())
  const lastSessionByProject = new Map<string, string>()
  let recentProjectsPromise: Promise<RecentProject[]> | undefined
  let recentProjectsMutation: Promise<void> = Promise.resolve()

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
    try {
      const current = await loadRecentProjects()
      const next = touchRecentProject(current, directory, now())
      await input.bridge.saveRecentProjects(next)
      setRecentProjects(next)
      return next
    } catch (cause) {
      // Recent-location persistence is a convenience cache. Keep the project
      // open and let the caller surface the non-blocking diagnostic.
      console.warn("Unable to persist recent project location", cause)
      throw cause
    }
  }

  async function openProject(directory: string): Promise<OpenedProject> {
    const existing = openProjects().find((project) => pathKey(project.directory) === pathKey(directory))
    if (existing) {
      setActiveProject(existing)
      return existing
    }

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
      throw new Error(tr("projects.backend-did-not-return-project-information"))
    }

    const opened = { directory, info: result.data, client }
    setOpenProjects((current) => {
      const key = pathKey(directory)
      return current.some((project) => pathKey(project.directory) === key) ? current : [...current, opened]
    })
    setActiveProject(opened)
    markUnavailable(directory, false)
    try {
      await persistRecent(directory)
    } catch {
      // The visible project state is already committed. Persistence can be
      // retried by a later open without rolling the user back to loading.
    }
    return opened
  }

  function rememberSession(directory: string, sessionID: string) {
    lastSessionByProject.set(pathKey(directory), sessionID)
  }

  function sessionFor(directory: string) {
    return lastSessionByProject.get(pathKey(directory))
  }

  function reorderProjects(sourceDirectory: string, targetDirectory: string, placement: "before" | "after") {
    const current = openProjects()
    const sourceIndex = current.findIndex((project) => pathKey(project.directory) === pathKey(sourceDirectory))
    if (sourceIndex < 0 || pathKey(sourceDirectory) === pathKey(targetDirectory)) return
    const next = [...current]
    const [moved] = next.splice(sourceIndex, 1)
    const targetIndex = next.findIndex((project) => pathKey(project.directory) === pathKey(targetDirectory))
    if (!moved || targetIndex < 0) return
    next.splice(targetIndex + (placement === "after" ? 1 : 0), 0, moved)
    setOpenProjects(next)
  }

  function closeProject(directory: string) {
    const current = openProjects()
    const index = current.findIndex((project) => pathKey(project.directory) === pathKey(directory))
    if (index < 0) return activeProject()
    const next = current.filter((_, projectIndex) => projectIndex !== index)
    const active = activeProject()
    const closingActive = active && pathKey(active.directory) === pathKey(directory)
    const nextActive = closingActive ? (current[index + 1] ?? current[index - 1]) : active
    lastSessionByProject.delete(pathKey(directory))
    setOpenProjects(next)
    if (closingActive) setActiveProject(nextActive)
    return nextActive
  }

  async function createInitialSession(opened: OpenedProject): Promise<CreatedProject> {
    const result = await opened.client.session.create({ directory: opened.directory }, { throwOnError: true })
    if (!result.data) throw new Error(tr("sessions.create-failed"))
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
    await error.opened.client.project.initGit({ directory: error.opened.directory }, { throwOnError: true })
    return createInitialSession(error.opened)
  }

  async function chooseAndOpenProject() {
    const directory = await input.bridge.chooseDirectory()
    if (!directory) return undefined
    return openProject(directory)
  }

  async function returnToProjectSelection() {
    setActiveProject(undefined)
    try {
      await input.bridge.saveLastLocation({})
    } catch (cause) {
      console.warn("Unable to clear the recent project location", cause)
      throw cause
    }
  }

  async function removeRecentProject(directory: string) {
    const mutation = recentProjectsMutation.then(async () => {
      await loadRecentProjects()
      const current = recentProjects()
      const key = pathKey(directory)
      const next = current.filter((project) => pathKey(project.path) !== key)
      await input.bridge.saveRecentProjects(next)
      setRecentProjects(next)
      markUnavailable(directory, false)
    })
    recentProjectsMutation = mutation.catch(() => undefined)
    await mutation
  }

  return {
    activeProject,
    openProjects,
    recentProjects,
    unavailableProjectKeys,
    isUnavailable: (directory: string) => unavailableProjectKeys().has(pathKey(directory)),
    loadRecentProjects,
    chooseDirectory: () => input.bridge.chooseDirectory(),
    chooseAndOpenProject,
    returnToProjectSelection,
    openProject,
    rememberSession,
    sessionFor,
    reorderProjects,
    closeProject,
    createProject,
    continueAfterGitFailure,
    removeRecentProject,
  }
}

export type ProjectController = ReturnType<typeof createProjectController>
