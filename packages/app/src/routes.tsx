import { HashRouter, Navigate, Route, useParams } from "@solidjs/router"
import { Show } from "solid-js"
import { DataProvider } from "./data/context"
import type { DesktopBootstrap } from "./platform/types"
import { useProjects } from "./features/projects/project-context"
import { WelcomePage } from "./features/projects/welcome-page"

function ProjectHome() {
  const projects = useProjects()
  return (
    <Show when={projects.activeProject()} fallback={<WelcomePage />}>
      {(project) => (
        <main class="project-ready">
          <div class="project-ready__content">
            <h1>项目已打开</h1>
            <p>后端连接成功。下一步将在这里加载和管理 Session。</p>
            <p class="project-ready__path">{project().directory}</p>
          </div>
        </main>
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
          <main class="session-placeholder">
            <div class="session-placeholder__content">
              <h1>Session 已创建</h1>
              <p>正在准备单 Agent 对话工作区。</p>
              <p class="project-ready__path">{params.sessionID}</p>
            </div>
          </main>
        </DataProvider>
      )}
    </Show>
  )
}

export function AppRoutes(props: { bootstrap: DesktopBootstrap }) {
  return (
    <HashRouter>
      <Route path="/" component={ProjectHome} />
      <Route path="/session/:sessionID" component={() => <SessionRoute bootstrap={props.bootstrap} />} />
    </HashRouter>
  )
}
