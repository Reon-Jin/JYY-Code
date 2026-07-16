import { tr } from "../../i18n/i18n-context"
import { FileText, RotateCcw } from "lucide-solid"
import { Show } from "solid-js"
import { Button } from "../../components/ui/button"
import { InlineError } from "../../components/ui/inline-error"
import { safeFailureMessage } from "./lifecycle-controller"
import "./lifecycle.css"

export type BackendUnavailableProps = {
  reason: string
  logPath?: string
  recovering?: boolean
  recoveryAvailable: boolean
  onRestart: () => void
  onBack: () => void
}

export function BackendUnavailable(props: BackendUnavailableProps) {
  return (
    <main class="lifecycle-failure" aria-labelledby="backend-unavailable-title">
      <div class="lifecycle-failure__content">
        <h1 id="backend-unavailable-title">{tr("lifecycle.local-backend-is-not-available")}</h1>
        <p>{tr("lifecycle.jyycode-cannot-connect-to-the-local-service-loaded")}</p>
        <InlineError message={safeFailureMessage(props.reason)} />
        <Show when={props.logPath}>
          {(path) => (
            <p class="lifecycle-failure__log">
              <FileText aria-hidden="true" />
              {tr("lifecycle.log-location")}<code>{path()}</code>
            </p>
          )}
        </Show>
        <div class="lifecycle-failure__actions">
          <Button
            disabled={!props.recoveryAvailable}
            loading={props.recovering}
            loadingLabel={tr("lifecycle.restarting")}
            onClick={props.onRestart}
          >
            <RotateCcw aria-hidden="true" />
            {tr("lifecycle.restart-backend")}
          </Button>
          <Button variant="secondary" onClick={props.onBack}>
            {tr("lifecycle.return-to-project-selection")}
          </Button>
        </div>
      </div>
    </main>
  )
}
