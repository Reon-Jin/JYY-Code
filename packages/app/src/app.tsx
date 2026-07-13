import { Show } from "solid-js"
import { DataProvider, type DataProviderInput } from "./data/context"
import { DesktopBridgeProvider } from "./platform/context"
import type { DesktopBridge } from "./platform/types"

export type AppProps = {
  bridge?: DesktopBridge
  data?: DataProviderInput
}

function StartupScreen() {
  return (
    <main class="startup-screen" role="status" aria-live="polite">
      正在启动 JYYCode…
    </main>
  )
}

export function App(props: AppProps) {
  return (
    <DesktopBridgeProvider bridge={props.bridge}>
      <Show when={props.data} fallback={<StartupScreen />}>
        {(data) => (
          <DataProvider
            bootstrap={data().bootstrap}
            generation={data().generation}
            directory={data().directory}
            activeSessionID={data().activeSessionID}
          >
            <StartupScreen />
          </DataProvider>
        )}
      </Show>
    </DesktopBridgeProvider>
  )
}
