import { HashRouter, Navigate, Route, useParams } from "@solidjs/router"
import { createSignal, lazy, onMount, Show, type Component, type ParentProps } from "solid-js"
import { Dynamic } from "solid-js/web"
import type { DesktopBootstrap } from "./platform/types"
import { useProjects } from "./features/projects/project-context"
import { WelcomePage } from "./features/projects/welcome-page"
import { ManagementProvider } from "./features/management/management-context"
import { ManagementShell } from "./features/management/management-shell"

const SkillsRoute = lazy(() => import("./features/management/skills-route"))
const McpRoute = lazy(() => import("./features/management/mcp-route"))
const SettingsRoute = lazy(() => import("./features/settings/settings-route"))

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
      正在加载工作区…
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

function ManagementRoute(props: ParentProps<{ bootstrap: DesktopBootstrap }>) {
  return (
    <ManagementProvider bootstrap={props.bootstrap}>
      <ManagementShell>{props.children}</ManagementShell>
    </ManagementProvider>
  )
}

function SettingsProviderRoute(props: { bootstrap: DesktopBootstrap }) {
  return (
    <ManagementProvider bootstrap={props.bootstrap}>
      <SettingsRoute />
    </ManagementProvider>
  )
}

export function AppRoutes(props: { bootstrap: DesktopBootstrap }) {
  return (
    <HashRouter>
      <Route
        path="/"
        component={() => (
          <ManagementRoute bootstrap={props.bootstrap}>
            <WelcomePage />
          </ManagementRoute>
        )}
      />
      <Route
        path="/skills"
        component={() => (
          <ManagementRoute bootstrap={props.bootstrap}>
            <SkillsRoute />
          </ManagementRoute>
        )}
      />
      <Route
        path="/skills/:name"
        component={() => (
          <ManagementRoute bootstrap={props.bootstrap}>
            <SkillsRoute />
          </ManagementRoute>
        )}
      />
      <Route
        path="/mcp"
        component={() => (
          <ManagementRoute bootstrap={props.bootstrap}>
            <McpRoute />
          </ManagementRoute>
        )}
      />
      <Route path="/workspace" component={() => <WorkspaceRoute bootstrap={props.bootstrap} />} />
      <Route path="/session/:sessionID" component={() => <WorkspaceRoute bootstrap={props.bootstrap} />} />
      <Route path="/settings" component={() => <SettingsProviderRoute bootstrap={props.bootstrap} />} />
      <Route path="/settings/:section" component={() => <SettingsProviderRoute bootstrap={props.bootstrap} />} />
    </HashRouter>
  )
}
