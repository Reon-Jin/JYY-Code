import { createSignal } from "solid-js"
import { createDesktopClient, type DesktopClient } from "../../data/sdk"
import type { DesktopBootstrap, DesktopBridge } from "../../platform/types"
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
}

export function safeFailureMessage(cause: unknown) {
  const message = typeof cause === "string" && cause.trim() ? cause : errorMessage(cause, "本地后端没有响应")
  return message
    .replace(/Basic\s+[A-Za-z0-9+/=]+/gi, "Basic [已隐藏]")
    .replace(/\b([A-Z][A-Z0-9_]{2,})=([^\s]+)/g, "$1=[已隐藏]")
}

export function createLifecycleController(input: LifecycleControllerInput) {
  const [phase, setPhase] = createSignal<LifecyclePhase>("booting")
  const [bootstrap, setBootstrap] = createSignal<DesktopBootstrap>()
  const [projects, setProjects] = createSignal<ProjectController>()
  const [route, setRoute] = createSignal("/")
  const [failure, setFailure] = createSignal<string>()
  const [recovering, setRecovering] = createSignal(false)
  const [recoveryAvailable, setRecoveryAvailable] = createSignal(true)
  let startPromise: Promise<void> | undefined

  function fail(cause: unknown) {
    setFailure(safeFailureMessage(cause))
    setPhase("failed")
  }

  async function persist(value: { project?: string; sessionID?: string }) {
    try {
      await input.bridge.saveLastLocation(value)
    } catch {
      // Persistence must not block an otherwise valid workspace.
    }
  }

  async function boot(allowRecovery: boolean) {
    setPhase("booting")
    setFailure(undefined)
    setRoute("/")
    if (allowRecovery) setRecoveryAvailable(true)

    let nextBootstrap: DesktopBootstrap
    try {
      nextBootstrap = await input.bridge.bootstrap()
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

    let location: Awaited<ReturnType<DesktopBridge["loadLastLocation"]>> = {}
    try {
      location = await input.bridge.loadLastLocation()
    } catch {
      location = {}
    }

    if (!location.project) {
      setPhase("ready")
      return
    }

    setPhase("projectLoading")
    let opened: OpenedProject
    try {
      opened = await controller.openProject(location.project)
    } catch {
      await persist({})
      setPhase("ready")
      return
    }

    if (!location.sessionID) {
      await persist({ project: opened.directory })
      setPhase("ready")
      return
    }

    try {
      const result = await opened.client.session.get(
        { directory: opened.directory, sessionID: location.sessionID },
        { throwOnError: true },
      )
      if (!result.data) throw new Error("Session 不存在")
      setRoute(`/session/${encodeURIComponent(result.data.id)}`)
      await persist({ project: opened.directory, sessionID: result.data.id })
    } catch {
      setRoute("/")
      await persist({ project: opened.directory })
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
    failure,
    recovering,
    recoveryAvailable,
    start,
    recover,
    returnToProjectSelection,
  }
}

export type LifecycleController = ReturnType<typeof createLifecycleController>
