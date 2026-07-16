import { tr } from "../../i18n/i18n-context"
import type { QueryClient } from "@tanstack/solid-query"
import { createEffect, createMemo, createSignal, For, on, Show } from "solid-js"
import { Button } from "../../components/ui/button"
import { Dialog } from "../../components/ui/dialog"
import { InlineError } from "../../components/ui/inline-error"
import { keys } from "../../data/query-keys"
import type { DesktopClient } from "../../data/sdk"
import type { CatalogModel, ModelSelection } from "../composer/model-catalog"
import { errorMessage } from "../projects/project-controller"
import {
  clusterModelLabel,
  clusterModelRoles,
  formatClusterModelValue,
  loadClusterModelConfig,
  resolveClusterModel,
  saveClusterModelConfig,
  type ClusterModelRoleKey,
  type ClusterModelSelections,
} from "./cluster-model-config"

export type ClusterModelDialogProps = {
  open: boolean
  client: Pick<DesktopClient, "global">
  queryClient: QueryClient
  models: readonly CatalogModel[]
  currentModel: ModelSelection
  onClose: () => void
  onSaved: (model: ModelSelection) => void
}

type SelectionValues = Record<ClusterModelRoleKey, string>

export function ClusterModelDialog(props: ClusterModelDialogProps) {
  const [loading, setLoading] = createSignal(false)
  const [saving, setSaving] = createSignal(false)
  const [failure, setFailure] = createSignal<string>()
  const [values, setValues] = createSignal<SelectionValues>()

  const validSelections = createMemo(() => {
    const current = values()
    if (!current) return undefined
    const selections = {} as ClusterModelSelections
    for (const role of clusterModelRoles) {
      const model = resolveClusterModel(current[role.key], props.models)
      if (!model) return undefined
      selections[role.key] = { providerID: model.providerID, modelID: model.modelID }
    }
    return selections
  })

  createEffect(
    on(
      () => props.open,
      (open) => {
        if (!open) return
        setFailure(undefined)
        setLoading(true)
        setValues(undefined)
        void loadClusterModelConfig(props.client)
          .then((config) => {
            if (!props.open) return
            const first = props.models[0]
            const plannerFallback = resolveClusterModel(formatClusterModelValue(props.currentModel), props.models) ?? first
            const next = Object.fromEntries(
              clusterModelRoles.map((role) => {
                const configured = config[role.key]
                const fallback = role.key === "planner_model" ? plannerFallback : first
                const resolved = resolveClusterModel(configured, props.models)
                return [
                  role.key,
                  resolved
                    ? formatClusterModelValue(resolved)
                    : (configured ?? (fallback ? formatClusterModelValue(fallback) : "")),
                ]
              }),
            ) as SelectionValues
            setValues(next)
          })
          .catch((cause) => setFailure(errorMessage(cause, tr("multi-agent.unable-to-load-global-model-configuration"))))
          .finally(() => setLoading(false))
      },
    ),
  )

  async function save() {
    const selections = validSelections()
    if (!selections) return
    setSaving(true)
    setFailure(undefined)
    try {
      await saveClusterModelConfig(props.client, selections)
      await props.queryClient.invalidateQueries({ queryKey: keys.globalConfig })
      props.onSaved(selections.planner_model)
      props.onClose()
    } catch (cause) {
      setFailure(errorMessage(cause, tr("multi-agent.unable-to-save-global-model-configuration")))
    } finally {
      setSaving(false)
    }
  }

  const footer = () => (
    <Button loading={saving()} loadingLabel={tr("multi-agent.saving")} disabled={loading() || !validSelections()} onClick={() => void save()}>
      {tr("github.save")}
    </Button>
  )

  return (
    <Dialog
      open={props.open}
      class="cluster-model-dialog"
      title={tr("multi-agent.configure-model")}
      description={tr("multi-agent.the-main-model-is-used-for-ordinary-single")}
      footer={footer()}
      showClose
      onClose={props.onClose}
    >
      <Show when={failure()}>{(message) => <InlineError message={message()} />}</Show>
      <Show when={!loading()} fallback={<p class="cluster-model-dialog__loading" role="status">{tr("multi-agent.loading-global-model-configuration")}</p>}>
        <Show when={values()}>
          {(current) => (
            <div class="cluster-model-dialog__roles">
              <For each={clusterModelRoles}>
                {(role) => {
                  const configured = () => current()[role.key]
                  const unavailable = () => Boolean(configured()) && !resolveClusterModel(configured(), props.models)
                  return (
                    <label class="cluster-model-dialog__role">
                      <span>{role.label}</span>
                      <small>{role.description}</small>
                      <select
                        aria-label={role.label}
                        value={configured()}
                        disabled={saving()}
                        onChange={(event) =>
                          setValues((value) => ({ ...value!, [role.key]: event.currentTarget.value }))
                        }
                      >
                        <Show when={unavailable()}>
                          <option value={configured()}>{tr("multi-agent.the-current-configuration-is-not-available")} {configured()}</option>
                        </Show>
                        <For each={props.models}>
                          {(model) => (
                            <option value={formatClusterModelValue(model)}>{clusterModelLabel(model)}</option>
                          )}
                        </For>
                      </select>
                    </label>
                  )
                }}
              </For>
            </div>
          )}
        </Show>
      </Show>
    </Dialog>
  )
}
