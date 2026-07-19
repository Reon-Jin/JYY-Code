import { createSignal } from "solid-js"
import { createDesktopClient, type DesktopClient } from "../../data/sdk"
import { tr } from "../../i18n/i18n-context"
import type { DesktopBootstrap, DesktopBridge, LastLocation } from "../../platform/types"
import { defaultDesktopSettings, type DesktopSettings } from "../settings/settings-preferences"
import {
  createProjectController,
  errorMessage,
  type OpenedProject,
  type ProjectController,
} from "../projects/project-controller"

export type LifecyclePhase = "booting" | "backendReady" | "projectLoading" | "ready" | "failed"

export type LifecycleControllerInput = {
  bridge: DesktopBridge
  clientFor?: (directory: string, bootstrap: DesktopBootstrap) => DesktopClient
  bootstrapTimeoutMs?: number
  restoreTimeoutMs?: number
}

const DEFAULT_BOOTSTRAP_TIMEOUT_MS = 22_000
const DEFAULT_RESTORE_TIMEOUT_MS = 10_000

function sameDirectory(left: string, right: string) {
  const normalize = (value: string) =>
    value.replaceAll("/", "\\").replace(/\\+$/, "").toLocaleLowerCase("en-US")
  return normalize(left) === normalize(right)
}

export function withTimeout<T>(promise: Promise<T>, milliseconds: number, message: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timeout = window.setTimeout(() => reject(new Error(message)), milliseconds)
    promise.then(
      (value) => {
        window.clearTimeout(timeout)
        resolve(value)
      },
      (cause) => {
        window.clearTimeout(timeout)
        reject(cause)
      },
    )
  })
}

export function safeFailureMessage(cause: unknown) {
  const message = typeof cause === "string" && cause.trim() ? cause : errorMessage(cause, tr("app.local-backend-is-not-responding"))
  return message
    .replace(/Basic\s+[A-Za-z0-9+/=]+/gi, `Basic [${tr("lifecycle.redacted")}]`)
    .replace(/\b([A-Z][A-Z0-9_]{2,})=([^\s]+)/g, `$1=[${tr("lifecycle.redacted")}]`)
}

export function createLifecycleController(input: LifecycleControllerInput) {
  const [phase, setPhase] = createSignal<LifecyclePhase>("booting")
  const [bootstrap, setBootstrap] = createSignal<DesktopBootstrap>()
  const [projects, setProjects] = createSignal<ProjectController>()
  const [route, setRoute] = createSignal("/")
  const [settings, setSettings] = createSignal<DesktopSettings>({ ...defaultDesktopSettings })
  const [failure, setFailure] = createSignal<string>()
  const [recovering, setRecovering] = createSignal(false)
  const [recoveryAvailable, setRecoveryAvailable] = createSignal(true)
  const restoreTimeoutMs = input.restoreTimeoutMs ?? DEFAULT_RESTORE_TIMEOUT_MS
  let startPromise: Promise<void> | undefined

  function fail(cause: unknown) {
    setFailure(safeFailureMessage(cause))
    setPhase("failed")
  }

  async function persist(value: LastLocation) {
    try {
      await withTimeout(input.bridge.saveLastLocation(value), restoreTimeoutMs, tr("lifecycle.save-startup-location-timeout"))
    } catch {
      // Persistence must not block an otherwise valid workspace.
    }
  }

  function persistedWorkspace(controller: ProjectController, project: string, sessionID?: string): LastLocation {
    const openProjects = controller.openProjects().map((opened) => {
      const rememberedSessionID = controller.sessionFor(opened.directory)
      return { path: opened.directory, ...(rememberedSessionID ? { sessionID: rememberedSessionID } : {}) }
    })
    return { project, ...(sessionID ? { sessionID } : {}), openProjects }
  }

  async function boot(allowRecovery: boolean) {
    setPhase("booting")
    setFailure(undefined)
    setRoute("/")
    if (allowRecovery) setRecoveryAvailable(true)

    let nextBootstrap: DesktopBootstrap
    try {
      nextBootstrap = await withTimeout(
        input.bridge.bootstrap(),
        input.bootstrapTimeoutMs ?? DEFAULT_BOOTSTRAP_TIMEOUT_MS,
        tr("lifecycle.backend-start-timeout"),
      )
    } catch (cause) {
      setBootstrap(undefined)
      setProjects(undefined)
      fail(cause)
      return
    }

    setBootstrap(nextBootstrap)
    setPhase("backendReady")
    const controller = createProjectController({
      bridge: input.bridge,
      bootstrap: nextBootstrap,
      ...(input.clientFor
        ? { clientFor: (directory: string) => input.clientFor!(directory, nextBootstrap) }
        : {}),
    })
    setProjects(controller)

    try {
      setSettings(await withTimeout(input.bridge.loadSettings(), restoreTimeoutMs, tr("lifecycle.read-settings-timeout")))
    } catch {
      setSettings({ ...defaultDesktopSettings })
    }

    if (settings().startup === "home") {
      setPhase("ready")
      return
    }

    let location: Awaited<ReturnType<DesktopBridge["loadLastLocation"]>> = {}
    try {
      location = await withTimeout(input.bridge.loadLastLocation(), restoreTimeoutMs, tr("lifecycle.read-last-location-timeout"))
    } catch {
      location = {}
    }

    if (!location.project) {
      setPhase("ready")
      return
    }

    setPhase("projectLoading")
    const storedProjects = location.openProjects?.length
      ? [...location.openProjects]
      : [{ path: location.project, ...(location.sessionID ? { sessionID: location.sessionID } : {}) }]
    if (!storedProjects.some((project) => sameDirectory(project.path, location.project!))) {
      storedProjects.push({
        path: location.project,
        ...(location.sessionID ? { sessionID: location.sessionID } : {}),
      })
    }

    let activeOpened: OpenedProject | undefined
    for (const stored of storedProjects) {
      try {
        const restored = await withTimeout(controller.openProject(stored.path), restoreTimeoutMs, tr("lifecycle.restore-project-timeout"))
        if (sameDirectory(stored.path, location.project)) activeOpened = restored
        if (stored.sessionID && !sameDirectory(stored.path, location.project)) {
          controller.rememberSession(stored.path, stored.sessionID)
        }
      } catch {
        // One unavailable project must not prevent the remaining tabs from restoring.
      }
    }

    let opened: OpenedProject
    if (activeOpened) {
      opened = await controller.openProject(activeOpened.directory)
    } else {
      const fallback = controller.activeProject()
      if (!fallback) {
        await persist({})
        setPhase("ready")
        return
      }
      setRoute("/workspace")
      await persist(persistedWorkspace(controller, fallback.directory))
      setPhase("ready")
      return
    }

    if (!location.sessionID) {
      setRoute("/workspace")
      await persist(persistedWorkspace(controller, opened.directory))
      setPhase("ready")
      return
    }

    try {
      const result = await withTimeout(
        opened.client.session.get(
          { directory: opened.directory, sessionID: location.sessionID },
          { throwOnError: true },
        ),
        restoreTimeoutMs,
        tr("lifecycle.restore-session-timeout"),
      )
      if (!result.data) throw new Error(tr("lifecycle.session-not-found"))
      controller.rememberSession(opened.directory, result.data.id)
      setRoute(`/session/${encodeURIComponent(result.data.id)}`)
      await persist(persistedWorkspace(controller, opened.directory, result.data.id))
    } catch {
      setRoute("/workspace")
      await persist(persistedWorkspace(controller, opened.directory))
    }
    setPhase("ready")
  }

  function start() {
    if (startPromise) return startPromise
    const task = boot(true).finally(() => {
      startPromise = undefined
    })
    startPromise = task
    return task
  }

  async function recover() {
    if (!recoveryAvailable() || recovering()) return
    setRecoveryAvailable(false)
    setRecovering(true)
    try {
      await input.bridge.restartBackend()
      await boot(false)
    } catch (cause) {
      fail(cause)
    } finally {
      setRecovering(false)
    }
  }

  async function returnToProjectSelection() {
    await persist({})
    setRoute("/")
    if (bootstrap() && projects()) {
      setPhase("ready")
      return
    }
    await recover()
  }

  return {
    phase,
    bootstrap,
    projects,
    project: () => projects()?.activeProject(),
    route,
    settings,
    failure,
    recovering,
    recoveryAvailable,
    start,
    recover,
    returnToProjectSelection,
  }
}

export type LifecycleController = ReturnType<typeof createLifecycleController>
