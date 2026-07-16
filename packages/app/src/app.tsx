import { tr } from "./i18n/i18n-context"
import { createEffect, ErrorBoundary, Match, onMount, Show, Switch } from "solid-js"
import { Button } from "./components/ui/button"
import { InlineError } from "./components/ui/inline-error"
import { ProjectProvider } from "./features/projects/project-context"
import type { ProjectController } from "./features/projects/project-controller"
import { BackendUnavailable } from "./features/lifecycle/backend-unavailable"
import { createLifecycleController } from "./features/lifecycle/lifecycle-controller"
import { StartupLoading } from "./features/lifecycle/startup-loading"
import { DesktopBridgeProvider, useDesktopBridge } from "./platform/context"
import type { DesktopBootstrap, DesktopBridge } from "./platform/types"
import { AppRoutes } from "./routes"
import { applyTheme } from "./features/settings/theme"
import { I18nProvider } from "./i18n/i18n-context"
import { applyStoredGlass } from "./features/settings/glass-preference"

export type AppProps = {
  bridge?: DesktopBridge
}

function ProjectApplication(props: { bootstrap: DesktopBootstrap; controller: ProjectController; route: string }) {
  const target = `#${props.route}`
  if (window.location.hash !== target) {
    window.history.replaceState(null, "", `${window.location.pathname}${window.location.search}${target}`)
  }
  return (
    <ProjectProvider controller={props.controller}>
      <AppRoutes bootstrap={props.bootstrap} />
    </ProjectProvider>
  )
}

function DesktopApplication() {
  const bridge = useDesktopBridge()
  const lifecycle = createLifecycleController({ bridge })
  createEffect(() => applyTheme(lifecycle.settings().theme))
  onMount(() => {
    void lifecycle
      .start()
      .then(() => applyStoredGlass(bridge, lifecycle.settings()))
      .catch(() => {
        document.documentElement.dataset.glass = "off"
      })
  })

  const loadingPhase = () => {
    const phase = lifecycle.phase()
    return phase === "backendReady" || phase === "projectLoading" ? phase : "booting"
  }

  return (
    <Switch fallback={<StartupLoading phase={loadingPhase()} />}>
      <Match when={lifecycle.phase() === "failed"}>
        <BackendUnavailable
          reason={tr("app.backend-start-failed", { reason: lifecycle.failure() ?? tr("app.local-backend-is-not-responding") })}
          logPath={lifecycle.bootstrap()?.logPath}
          recovering={lifecycle.recovering()}
          recoveryAvailable={lifecycle.recoveryAvailable()}
          onRestart={() => void lifecycle.recover()}
          onBack={() => void lifecycle.returnToProjectSelection()}
        />
      </Match>
      <Match when={lifecycle.phase() === "ready"}>
        <Show when={lifecycle.bootstrap()} keyed fallback={<StartupLoading phase="booting" />}>
          {(bootstrap) => (
            <Show when={lifecycle.projects()} keyed fallback={<StartupLoading phase="booting" />}>
              {(projects) => (
                <ProjectApplication bootstrap={bootstrap} controller={projects} route={lifecycle.route()} />
              )}
            </Show>
          )}
        </Show>
      </Match>
    </Switch>
  )
}

export function App(props: AppProps) {
  return (
    <ErrorBoundary
      fallback={(error, reset) => (
        <main class="startup-screen">
          <div class="startup-error">
            <InlineError
              message={tr("app.interface-failed", { reason: error instanceof Error ? error.message : tr("app.unknown-error") })}
            />
            <Button variant="secondary" onClick={reset}>
              {tr("app.reload-interface")}
            </Button>
          </div>
        </main>
      )}
    >
      <DesktopBridgeProvider bridge={props.bridge}>
        <I18nProvider>
          <DesktopApplication />
        </I18nProvider>
      </DesktopBridgeProvider>
    </ErrorBoundary>
  )
}
