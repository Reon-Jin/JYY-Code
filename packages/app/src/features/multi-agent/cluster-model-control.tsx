import { tr } from "../../i18n/i18n-context"
import type { QueryClient } from "@tanstack/solid-query"
import { Settings2 } from "lucide-solid"
import { createMemo, createSignal, Show } from "solid-js"
import { Button } from "../../components/ui/button"
import type { DesktopClient } from "../../data/sdk"
import type { CatalogModel, ModelSelection } from "../composer/model-catalog"
import { clusterModelLabel } from "./cluster-model-config"
import { ClusterModelDialog } from "./cluster-model-dialog"
import "./multi-agent.css"

export type ClusterModelControlProps = {
  client: Pick<DesktopClient, "global">
  queryClient: QueryClient
  models: readonly CatalogModel[]
  currentModel: ModelSelection
  disabled?: boolean
  identityLocked?: boolean
  onModelChange: (model: ModelSelection) => void
}

export function ClusterModelControl(props: ClusterModelControlProps) {
  const [open, setOpen] = createSignal(false)
  const [announcement, setAnnouncement] = createSignal("")
  const currentLabel = createMemo(() => {
    const model = props.models.find(
      (candidate) => candidate.providerID === props.currentModel.providerID && candidate.modelID === props.currentModel.modelID,
    )
    return model ? clusterModelLabel(model) : `${props.currentModel.providerID}/${props.currentModel.modelID}`
  })

  return (
    <div class="cluster-model-control">
      <Button
        size="small"
        variant="secondary"
        class="cluster-model-control__button"
        aria-label={props.identityLocked ? tr("multi-agent.current-model", { model: currentLabel() }) : tr("multi-agent.configure-model-value", { model: currentLabel() })}
        disabled={props.disabled || props.identityLocked}
        onClick={() => {
          setAnnouncement("")
          setOpen(true)
        }}
      >
        <Settings2 aria-hidden="true" />
        <span>{tr("multi-agent.master-model")}</span>
        <strong>{currentLabel()}</strong>
      </Button>
      <Show when={announcement()}>
        <p class="cluster-model-control__status" role="status" aria-live="polite">
          {announcement()}
        </p>
      </Show>
      <ClusterModelDialog
        open={open()}
        client={props.client}
        queryClient={props.queryClient}
        models={props.models}
        currentModel={props.currentModel}
        onClose={() => setOpen(false)}
        onSaved={(model) => {
          props.onModelChange(model)
          setAnnouncement(tr("multi-agent.saved-to-global-configuration"))
        }}
      />
    </div>
  )
}
