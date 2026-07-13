import { DesktopBridgeProvider } from "./platform/context"
import type { DesktopBridge } from "./platform/types"

export type AppProps = {
  bridge?: DesktopBridge
}

export function App(props: AppProps) {
  return (
    <DesktopBridgeProvider bridge={props.bridge}>
      <main class="startup-screen" role="status" aria-live="polite">
        正在启动 JYYCode…
      </main>
    </DesktopBridgeProvider>
  )
}
