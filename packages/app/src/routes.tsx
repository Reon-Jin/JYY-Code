import { HashRouter, Navigate, Route, useParams } from "@solidjs/router"
import { lazy, Show, Suspense } from "solid-js"
import type { DesktopBootstrap } from "./platform/types"
import { useProjects } from "./features/projects/project-context"
import { WelcomePage } from "./features/projects/welcome-page"

const ProjectWorkspace = lazy(() => import("./layout/project-workspace"))

function WorkspaceLoading() {
  return (
    <main class="startup-screen" role="status" aria-live="polite">
      正在加载工作区…
    </main>
  )
}

function ProjectHome(props: { bootstrap: DesktopBootstrap }) {
  const projects = useProjects()
  return (
    <Show when={projects.activeProject()} fallback={<WelcomePage />}>
      {(project) => (
        <Suspense fallback={<WorkspaceLoading />}>
          <ProjectWorkspace bootstrap={props.bootstrap} directory={project().directory} />
        </Suspense>
      )}
    </Show>
  )
}

function SessionRoute(props: { bootstrap: DesktopBootstrap }) {
  const projects = useProjects()
  const params = useParams<{ sessionID: string }>()

  return (
    <Show when={projects.activeProject()} fallback={<Navigate href="/" />}>
      {(project) => (
        <Suspense fallback={<WorkspaceLoading />}>
          <ProjectWorkspace
            bootstrap={props.bootstrap}
            directory={project().directory}
            activeSessionID={params.sessionID}
          />
        </Suspense>
      )}
    </Show>
  )
}

export function AppRoutes(props: { bootstrap: DesktopBootstrap }) {
  return (
    <HashRouter>
      <Route path="/" component={() => <ProjectHome bootstrap={props.bootstrap} />} />
      <Route path="/session/:sessionID" component={() => <SessionRoute bootstrap={props.bootstrap} />} />
    </HashRouter>
  )
}
