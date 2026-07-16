import { tr } from "../../i18n/i18n-context"
import type { LifecyclePhase } from "./lifecycle-controller"
import "./lifecycle.css"

function phaseMessage(phase: Exclude<LifecyclePhase, "ready" | "failed">) {
  switch (phase) {
    case "backendReady":
      return tr("lifecycle.reading-last-location")
    case "projectLoading":
      return tr("lifecycle.restoring-project-and-session")
    default:
      return tr("lifecycle.starting-jyycode")
  }
}

export function StartupLoading(props: { phase: Exclude<LifecyclePhase, "ready" | "failed"> }) {
  return (
    <main class="startup-screen" role="status" aria-live="polite">
      {phaseMessage(props.phase)}
    </main>
  )
}
