import { HashRouter, Navigate, Route, useParams } from "@solidjs/router"
import { createSignal, onMount, Show, type Component } from "solid-js"
import { Dynamic } from "solid-js/web"
import type { DesktopBootstrap } from "./platform/types"
import { useProjects } from "./features/projects/project-context"
import { WelcomePage } from "./features/projects/welcome-page"

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
      fallback={<Show when={!params.sessionID} fallback={<Navigate href="/" />}><WelcomePage /></Show>}
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

export function AppRoutes(props: { bootstrap: DesktopBootstrap }) {
  return (
    <HashRouter>
      <Route path={["/", "/session/:sessionID"]} component={() => <WorkspaceRoute bootstrap={props.bootstrap} />} />
    </HashRouter>
  )
}
