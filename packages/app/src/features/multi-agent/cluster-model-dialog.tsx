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
type VariantValues = Record<ClusterModelRoleKey, string>

export function ClusterModelDialog(props: ClusterModelDialogProps) {
  const [loading, setLoading] = createSignal(false)
  const [saving, setSaving] = createSignal(false)
  const [failure, setFailure] = createSignal<string>()
  const [values, setValues] = createSignal<SelectionValues>()
  const [variants, setVariants] = createSignal<VariantValues>()

  const validSelections = createMemo(() => {
    const current = values()
    const currentVariants = variants()
    if (!current || !currentVariants) return undefined
    const selections = {} as ClusterModelSelections
    for (const role of clusterModelRoles) {
      const model = resolveClusterModel(current[role.key], props.models)
      if (!model) return undefined
      const variant = currentVariants[role.key]
      if (variant && !model.variants.includes(variant)) return undefined
      selections[role.key] = { providerID: model.providerID, modelID: model.modelID }
      if (variant) selections[role.key].variant = variant
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
        setVariants(undefined)
        void loadClusterModelConfig(props.client)
          .then((config) => {
            if (!props.open) return
            const first = props.models[0]
            const plannerFallback =
              resolveClusterModel(formatClusterModelValue(props.currentModel), props.models) ?? first
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
            const nextVariants = Object.fromEntries(
              clusterModelRoles.map((role) => {
                const model = resolveClusterModel(next[role.key], props.models)
                const configuredVariant = config[role.variantKey]
                return [role.key, model?.variants.includes(configuredVariant ?? "") ? configuredVariant! : ""]
              }),
            ) as VariantValues
            setValues(next)
            setVariants(nextVariants)
          })
          .catch((cause) =>
            setFailure(errorMessage(cause, tr("multi-agent.unable-to-load-global-model-configuration"))),
          )
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
    <Button
      loading={saving()}
      loadingLabel={tr("multi-agent.saving")}
      disabled={loading() || !validSelections()}
      onClick={() => void save()}
    >
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
      <Show
        when={!loading()}
        fallback={
          <p class="cluster-model-dialog__loading" role="status">
            {tr("multi-agent.loading-global-model-configuration")}
          </p>
        }
      >
        <Show when={values()}>
          {(current) => (
            <div class="cluster-model-dialog__roles">
              <For each={clusterModelRoles}>
                {(role) => {
                  const configured = () => current()[role.key]
                  const unavailable = () => Boolean(configured()) && !resolveClusterModel(configured(), props.models)
                  const selectedModel = () => resolveClusterModel(configured(), props.models)
                  const currentVariant = () => variants()?.[role.key] ?? ""
                  const availableVariants = () => selectedModel()?.variants ?? []
                  const variantUnavailable = () =>
                    Boolean(currentVariant()) && !availableVariants().includes(currentVariant())
                  return (
                    <label class="cluster-model-dialog__role">
                      <span>{role.label}</span>
                      <small>{role.description}</small>
                      <div class="cluster-model-dialog__controls">
                        <select
                          aria-label={role.label}
                          value={configured()}
                          disabled={saving()}
                          onChange={(event) => {
                            const value = event.currentTarget.value
                            setValues((currentValue) => ({ ...currentValue!, [role.key]: value }))
                            setVariants((currentValue) => ({ ...currentValue!, [role.key]: "" }))
                          }}
                        >
                          <Show when={unavailable()}>
                            <option value={configured()}>
                              {tr("multi-agent.the-current-configuration-is-not-available")} {configured()}
                            </option>
                          </Show>
                          <For each={props.models}>
                            {(model) => (
                              <option value={formatClusterModelValue(model)}>{clusterModelLabel(model)}</option>
                            )}
                          </For>
                        </select>
                        <div class="cluster-model-dialog__variant">
                          <span>{tr("multi-agent.thinking-depth")}</span>
                          <select
                            aria-label={`${role.label} · ${tr("multi-agent.thinking-depth")}`}
                            value={currentVariant()}
                            disabled={saving()}
                            onChange={(event) =>
                              setVariants((value) => ({ ...value!, [role.key]: event.currentTarget.value }))
                            }
                          >
                            <Show when={variantUnavailable()}>
                              <option value={currentVariant()}>
                                {tr("multi-agent.the-current-configuration-is-not-available")} {currentVariant()}
                              </option>
                            </Show>
                            <option value="">{tr("multi-agent.default")}</option>
                            <For each={availableVariants()}>
                              {(variant) => <option value={variant}>{variant}</option>}
                            </For>
                          </select>
                        </div>
                      </div>
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
