import { LoaderCircle, WifiOff } from "lucide-solid"
import { Show } from "solid-js"
import type { ConnectionState } from "../../data/event-bridge"
import "./lifecycle.css"

export function ReconnectBanner(props: { state: Exclude<ConnectionState, "connected"> }) {
  return (
    <aside class="reconnect-banner" data-state={props.state} role="status" aria-live="polite">
      <Show when={props.state === "disconnected"} fallback={<LoaderCircle aria-hidden="true" />}>
        <WifiOff aria-hidden="true" />
      </Show>
      <span>{props.state === "disconnected" ? "连接已中断，正在重新连接…" : "正在连接后端…"}</span>
    </aside>
  )
}
