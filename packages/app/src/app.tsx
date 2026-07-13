import { createSignal, ErrorBoundary, onCleanup, onMount, Show } from "solid-js"
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
  const [bootstrap, setBootstrap] = createSignal<DesktopBootstrap>()
  const [startupError, setStartupError] = createSignal<string>()
  const [starting, setStarting] = createSignal(true)
  let disposed = false

  async function start(restart = false) {
    setStarting(true)
    setStartupError(undefined)
    try {
      if (restart) await bridge.restartBackend()
      const value = await bridge.bootstrap()
      if (!disposed) setBootstrap(value)
    } catch (error) {
      if (!disposed) {
        setBootstrap(undefined)
        setStartupError(error instanceof Error && error.message ? error.message : "本地后端没有响应")
      }
    } finally {
      if (!disposed) setStarting(false)
    }
  }

  onMount(() => void start())
  onCleanup(() => {
    disposed = true
  })

  return (
    <Show
      when={bootstrap()}
      fallback={
        <Show
          when={startupError()}
          fallback={<StartupScreen />}
        >
          {(message) => <main class="startup-screen">
            <div class="startup-error">
              <InlineError message={`JYYCode 本地后端启动失败：${message()}`} />
              <Button variant="secondary" loading={starting()} onClick={() => void start(true)}>
                重试启动
              </Button>
            </div>
          </main>}
        </Show>
      }
    >
      {(value) => <ProjectApplication bootstrap={value()} bridge={bridge} />}
    </Show>
  )
}

export function App(props: AppProps) {
  return (
    <ErrorBoundary
      fallback={(error, reset) => (
        <main class="startup-screen">
          <div class="startup-error">
            <InlineError
              message={`JYYCode 界面运行失败：${error instanceof Error ? error.message : "未知错误"}`}
            />
            <Button variant="secondary" onClick={reset}>
              重新加载界面
            </Button>
          </div>
        </main>
      )}
    >
      <DesktopBridgeProvider bridge={props.bridge}>
        <DesktopApplication />
      </DesktopBridgeProvider>
    </ErrorBoundary>
  )
}
