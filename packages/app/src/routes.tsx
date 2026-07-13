import { HashRouter, Navigate, Route, useParams } from "@solidjs/router"
import { Show } from "solid-js"
import { DataProvider } from "./data/context"
import type { DesktopBootstrap } from "./platform/types"
import { useProjects } from "./features/projects/project-context"
import { WelcomePage } from "./features/projects/welcome-page"
import { WorkspaceLayout } from "./layout/workspace-layout"

function ProjectHome(props: { bootstrap: DesktopBootstrap }) {
  const projects = useProjects()
  return (
    <Show when={projects.activeProject()} fallback={<WelcomePage />}>
      {(project) => (
        <DataProvider bootstrap={props.bootstrap} generation={0} directory={project().directory}>
          <WorkspaceLayout />
        </DataProvider>
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
        <DataProvider
          bootstrap={props.bootstrap}
          generation={0}
          directory={project().directory}
          activeSessionID={() => params.sessionID}
        >
          <WorkspaceLayout activeSessionID={params.sessionID} />
        </DataProvider>
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
