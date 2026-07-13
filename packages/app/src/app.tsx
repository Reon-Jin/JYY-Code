import { createResource, Show } from "solid-js"
import { Button } from "./components/ui/button"
import { InlineError } from "./components/ui/inline-error"
import { createProjectController } from "./features/projects/project-controller"
import { ProjectProvider } from "./features/projects/project-context"
import { DesktopBridgeProvider, useDesktopBridge } from "./platform/context"
import type { DesktopBootstrap, DesktopBridge } from "./platform/types"
import { AppRoutes } from "./routes"

export type AppProps = {
  bridge?: DesktopBridge
}

function StartupScreen(props: { message?: string }) {
  return (
    <main class="startup-screen" role="status" aria-live="polite">
      {props.message ?? "正在启动 JYYCode…"}
    </main>
  )
}

function ProjectApplication(props: { bootstrap: DesktopBootstrap; bridge: DesktopBridge }) {
  const controller = createProjectController({ bridge: props.bridge, bootstrap: props.bootstrap })
  return (
    <ProjectProvider controller={controller}>
      <AppRoutes bootstrap={props.bootstrap} />
    </ProjectProvider>
  )
}

function DesktopApplication() {
  const bridge = useDesktopBridge()
  const [bootstrap, { refetch }] = createResource(() => bridge.bootstrap())

  return (
    <Show
      when={bootstrap()}
      fallback={
        <Show
          when={bootstrap.error}
          fallback={<StartupScreen />}
        >
          <main class="startup-screen">
            <div class="startup-error">
              <InlineError message="JYYCode 本地后端启动失败" />
              <Button variant="secondary" onClick={() => void refetch()}>
                重试启动
              </Button>
            </div>
          </main>
        </Show>
      }
    >
      {(value) => <ProjectApplication bootstrap={value()} bridge={bridge} />}
    </Show>
  )
}

export function App(props: AppProps) {
  return (
    <DesktopBridgeProvider bridge={props.bridge}>
      <DesktopApplication />
    </DesktopBridgeProvider>
  )
}
