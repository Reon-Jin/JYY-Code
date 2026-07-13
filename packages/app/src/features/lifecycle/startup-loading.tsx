import type { LifecyclePhase } from "./lifecycle-controller"
import "./lifecycle.css"

function phaseMessage(phase: Exclude<LifecyclePhase, "ready" | "failed">) {
  switch (phase) {
    case "backendReady":
      return "正在读取上次位置…"
    case "projectLoading":
      return "正在恢复项目与 Session…"
    default:
      return "正在启动 JYYCode…"
  }
}

export function StartupLoading(props: { phase: Exclude<LifecyclePhase, "ready" | "failed"> }) {
  return (
    <main class="startup-screen" role="status" aria-live="polite">
      {phaseMessage(props.phase)}
    </main>
  )
}
