import { tr } from "./i18n/i18n-context"
import { HashRouter, Navigate, Route, useParams, type RouteSectionProps } from "@solidjs/router"
import { createSignal, lazy, onMount, Show, type Component, type ParentProps } from "solid-js"
import { Dynamic } from "solid-js/web"
import type { DesktopBootstrap } from "./platform/types"
import { useProjects } from "./features/projects/project-context"
import { WelcomePage } from "./features/projects/welcome-page"
import { ManagementProvider } from "./features/management/management-context"
import { ManagementShell } from "./features/management/management-shell"

const SkillsRoute = lazy(() => import("./features/management/skills-route"))
const McpRoute = lazy(() => import("./features/management/mcp-route"))
const WorkflowsRoute = lazy(() => import("./features/management/workflows-route"))
const SettingsRoute = lazy(() => import("./features/settings/settings-route"))
const MemorySettingsRoute = lazy(() => import("./features/settings/memory-settings-route"))

type ProjectWorkspaceComponent = Component<{
  bootstrap: DesktopBootstrap
  directory: string
  activeSessionID?: string
}>

let projectWorkspacePromise: Promise<{ default: ProjectWorkspaceComponent }> | undefined

function loadProjectWorkspace() {
  projectWorkspacePromise ??= import("./layout/project-workspace")
  return projectWorkspacePromise
}

function WorkspaceLoading() {
  return (
    <main class="startup-screen" role="status" aria-live="polite">
      {tr("routes.loading-workspace")}
    </main>
  )
}

function WorkspaceRoute(props: { bootstrap: DesktopBootstrap }) {
  const projects = useProjects()
  const params = useParams<{ sessionID?: string }>()
  const [Workspace, setWorkspace] = createSignal<ProjectWorkspaceComponent>()

  onMount(() => {
    void loadProjectWorkspace().then((module) => setWorkspace(() => module.default))
  })

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
        <Show when={Workspace()} fallback={<WorkspaceLoading />}>
          {(Component) => (
            <Dynamic
              component={Component()}
              bootstrap={props.bootstrap}
              directory={project().directory}
              activeSessionID={params.sessionID}
            />
          )}
        </Show>
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
    pathname.startsWith("/workflows") ||
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

export function AppRoutes(props: { bootstrap: DesktopBootstrap }) {
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
      <Route path="/workflows" component={() => <ManagementRoute><WorkflowsRoute /></ManagementRoute>} />
      <Route path="/workspace" component={() => <WorkspaceRoute bootstrap={props.bootstrap} />} />
      <Route path="/session/:sessionID" component={() => <WorkspaceRoute bootstrap={props.bootstrap} />} />
      <Route path="/settings" component={SettingsRoute} />
      <Route path="/settings/memory/:scope" component={MemorySettingsRoute} />
      <Route path="/settings/:section" component={SettingsRoute} />
    </HashRouter>
  )
}
