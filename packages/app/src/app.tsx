import { tr } from "./i18n/i18n-context"
import { createEffect, ErrorBoundary, Match, onCleanup, onMount, Show, Switch } from "solid-js"
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
import { createDesktopNotifications } from "./features/notifications/desktop-notifications"
import { runDesktopUpdater } from "./features/settings/desktop-updater"

export type AppProps = {
  bridge?: DesktopBridge
}

function LiquidGlassFilters() {
  return (
    <svg class="liquid-glass-definitions" width="0" height="0" aria-hidden="true">
      <defs>
        <filter id="liquid-glass-refraction" x="-12%" y="-12%" width="124%" height="124%" color-interpolation-filters="sRGB">
          <feTurbulence type="fractalNoise" baseFrequency="0.012 0.018" numOctaves="2" seed="17" result="noise" />
          <feGaussianBlur in="noise" stdDeviation="1.8" result="softNoise" />
          <feDisplacementMap in="SourceGraphic" in2="softNoise" scale="16" xChannelSelector="R" yChannelSelector="G" />
        </filter>
      </defs>
    </svg>
  )
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
  const notifications = createDesktopNotifications({ bridge, settings: lifecycle.settings })
  createEffect(() => applyTheme(lifecycle.settings().theme))
  onCleanup(() => notifications.dispose())
  onMount(() => {
    void lifecycle
      .start()
      .then(async () => {
        notifications.setPermission(
          await (bridge.getNotificationPermission?.() ?? Promise.resolve("unsupported" as const)).catch(
            () => "default" as const,
          ),
        )
        notifications.start()
        await applyStoredGlass(bridge, lifecycle.settings())
        void runDesktopUpdater(bridge, lifecycle.settings())
      })
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
      <LiquidGlassFilters />
      <DesktopBridgeProvider bridge={props.bridge}>
        <I18nProvider>
          <DesktopApplication />
        </I18nProvider>
      </DesktopBridgeProvider>
    </ErrorBoundary>
  )
}
