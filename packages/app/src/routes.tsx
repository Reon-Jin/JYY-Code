import { tr } from "./i18n/i18n-context"
import { HashRouter, Navigate, Route, useParams, type RouteSectionProps } from "@solidjs/router"
import { createSignal, lazy, onCleanup, onMount, Show, Switch, Match, type Component, type ParentProps } from "solid-js"
import { Dynamic } from "solid-js/web"
import type { DesktopBootstrap } from "./platform/types"
import { useProjects } from "./features/projects/project-context"
import { WelcomePage } from "./features/projects/welcome-page"
import { ManagementProvider } from "./features/management/management-context"
import { ManagementShell } from "./features/management/management-shell"
import { Button } from "./components/ui/button"
import { InlineError } from "./components/ui/inline-error"
import { errorMessage } from "./features/projects/project-controller"
import { useNavigate } from "@solidjs/router"
import { completeUIPerformanceStage } from "./performance/ui-performance"

const SkillsRoute = lazy(() => import("./features/management/skills-route"))
const McpRoute = lazy(() => import("./features/management/mcp-route"))
const SettingsRoute = lazy(() => import("./features/settings/settings-route"))
const MemorySettingsRoute = lazy(() => import("./features/settings/memory-settings-route"))

export type ProjectWorkspaceComponent = Component<{
  bootstrap: DesktopBootstrap
  directory: string
  activeSessionID?: string
}>

export type ProjectWorkspaceModule = { default: ProjectWorkspaceComponent }
export type ProjectWorkspaceLoader = () => Promise<ProjectWorkspaceModule>

let projectWorkspacePromise: Promise<ProjectWorkspaceModule> | undefined

function loadProjectWorkspace(): Promise<ProjectWorkspaceModule> {
  projectWorkspacePromise ??= import("./layout/project-workspace").catch((cause) => {
    projectWorkspacePromise = undefined
    throw cause
  })
  return projectWorkspacePromise
}

function loadWithTimeout<T>(promise: Promise<T>, milliseconds: number) {
  return new Promise<T>((resolve, reject) => {
    const timeout = window.setTimeout(() => reject(new Error("Workspace component loading timed out")), milliseconds)
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

const workspaceLoadTimeoutMs = 15_000

function WorkspaceLoading() {
  return (
    <main class="startup-screen" role="status" aria-live="polite">
      {tr("routes.loading-workspace-chunk")}
    </main>
  )
}

function WorkspaceLoadError(props: { error: unknown; onRetry: () => void; onReturn: () => Promise<void> }) {
  const [returning, setReturning] = createSignal(false)
  const [returnError, setReturnError] = createSignal<string>()

  async function returnToProjectSelection() {
    if (returning()) return
    setReturning(true)
    setReturnError(undefined)
    try {
      await props.onReturn()
    } catch (cause) {
      setReturnError(errorMessage(cause, tr("lifecycle.return-to-project-selection")))
    } finally {
      setReturning(false)
    }
  }

  return (
    <main class="startup-screen" aria-live="assertive">
      <div class="startup-error">
        <InlineError
          message={tr("routes.workspace-load-failed", {
            reason: errorMessage(props.error, tr("routes.loading-workspace-chunk")),
          })}
        />
        <div class="startup-error__actions">
          <Button onClick={props.onRetry}>{tr("routes.retry-loading-workspace")}</Button>
          <Button variant="secondary" loading={returning()} onClick={() => void returnToProjectSelection()}>
            {tr("lifecycle.return-to-project-selection")}
          </Button>
        </div>
        <Show when={returnError()}>{(message) => <InlineError message={message()} />}</Show>
      </div>
    </main>
  )
}

type WorkspaceLoadState =
  | { status: "loading" }
  | { status: "ready"; component: ProjectWorkspaceComponent }
  | { status: "error"; error: unknown }

function WorkspaceRoute(props: { bootstrap: DesktopBootstrap; workspaceLoader?: ProjectWorkspaceLoader }) {
  const projects = useProjects()
  const params = useParams<{ sessionID?: string }>()
  const navigate = useNavigate()
  const loader = props.workspaceLoader ?? loadProjectWorkspace
  const [state, setState] = createSignal<WorkspaceLoadState>({ status: "loading" })
  let attempt = 0
  let disposed = false

  function retry() {
    const currentAttempt = ++attempt
    setState({ status: "loading" })
    void loadWithTimeout(Promise.resolve().then(loader), workspaceLoadTimeoutMs)
      .then((module) => {
        if (disposed || currentAttempt !== attempt) return
        completeUIPerformanceStage("workspace-chunk-ready")
        setState({ status: "ready", component: module.default })
      })
      .catch((error) => {
        if (disposed || currentAttempt !== attempt) return
        if (error instanceof Error && error.message === "Workspace component loading timed out") {
          projectWorkspacePromise = undefined
        }
        setState({ status: "error", error })
      })
  }

  onMount(retry)
  onCleanup(() => {
    disposed = true
  })

  async function returnToProjectSelection() {
    await projects.returnToProjectSelection()
    navigate("/")
  }

  return (
    <Show
      when={projects.activeProject()}
      fallback={
        <Show when={!params.sessionID} fallback={<Navigate href="/" />}>
          <WelcomePage />
        </Show>
      }
    >
      {(project) => (
        <Switch>
          <Match when={state().status === "loading"}>
            <WorkspaceLoading />
          </Match>
          <Match when={state().status === "error"}>
            <WorkspaceLoadError
              error={(state() as Extract<WorkspaceLoadState, { status: "error" }>).error}
              onRetry={retry}
              onReturn={returnToProjectSelection}
            />
          </Match>
          <Match when={state().status === "ready"}>
            <Dynamic
              component={(state() as Extract<WorkspaceLoadState, { status: "ready" }>).component}
              bootstrap={props.bootstrap}
              directory={project().directory}
              activeSessionID={params.sessionID}
            />
          </Match>
        </Switch>
      )}
    </Show>
  )
}

function ManagementRoute(props: ParentProps) {
  return <ManagementShell>{props.children}</ManagementShell>
}

function isManagementPath(pathname: string) {
  return (
    pathname === "/" ||
    pathname.startsWith("/skills") ||
    pathname.startsWith("/mcp") ||
    pathname.startsWith("/settings")
  )
}

function AppRouteRoot(props: RouteSectionProps & { bootstrap: DesktopBootstrap }) {
  const management = () => isManagementPath(props.location.pathname)

  return (
    <Show when={management()} fallback={props.children}>
      <ManagementProvider bootstrap={props.bootstrap}>{props.children}</ManagementProvider>
    </Show>
  )
}

export function AppRoutes(props: { bootstrap: DesktopBootstrap; workspaceLoader?: ProjectWorkspaceLoader }) {
  return (
    <HashRouter root={(route) => <AppRouteRoot {...route} bootstrap={props.bootstrap} />}>
      <Route
        path="/"
        component={() => (
          <ManagementRoute>
            <WelcomePage />
          </ManagementRoute>
        )}
      />
      <Route
        path="/skills"
        component={() => (
          <ManagementRoute>
            <SkillsRoute />
          </ManagementRoute>
        )}
      />
      <Route
        path="/skills/:name"
        component={() => (
          <ManagementRoute>
            <SkillsRoute />
          </ManagementRoute>
        )}
      />
      <Route
        path="/mcp"
        component={() => (
          <ManagementRoute>
            <McpRoute />
          </ManagementRoute>
        )}
      />
      <Route
        path="/workspace"
        component={() => <WorkspaceRoute bootstrap={props.bootstrap} workspaceLoader={props.workspaceLoader} />}
      />
      <Route
        path="/session/:sessionID"
        component={() => <WorkspaceRoute bootstrap={props.bootstrap} workspaceLoader={props.workspaceLoader} />}
      />
      <Route path="/settings" component={SettingsRoute} />
      <Route path="/settings/memory/:scope" component={MemorySettingsRoute} />
      <Route path="/settings/:section" component={SettingsRoute} />
    </HashRouter>
  )
}
