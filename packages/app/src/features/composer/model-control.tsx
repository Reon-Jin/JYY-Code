import { tr } from "../../i18n/i18n-context"
import { SlidersHorizontal } from "lucide-solid"
import { createMemo, createSignal, For } from "solid-js"
import { Button } from "../../components/ui/button"
import { Dialog } from "../../components/ui/dialog"
import type { CatalogModel, ModelSelection } from "./model-catalog"

function modelKey(model: ModelSelection) {
  return `${model.providerID}/${model.modelID}`
}

function modelLabel(model: ModelSelection, models: readonly CatalogModel[]) {
  const catalogModel = models.find((candidate) => modelKey(candidate) === modelKey(model))
  if (!catalogModel) return `${model.providerID}/${model.modelID}`
  return `${catalogModel.providerName} · ${catalogModel.modelName}`
}

function variantLabel(variant: string | undefined) {
  if (!variant) return tr("composer.thinking-depth-default")
  const labels: Record<string, string> = {
    low: tr("composer.thinking-depth-low"),
    medium: tr("composer.thinking-depth-medium"),
    high: tr("composer.thinking-depth-high"),
    max: tr("composer.thinking-depth-max"),
  }
  return labels[variant] ?? variant
}

function variantsFor(model: ModelSelection, models: readonly CatalogModel[]) {
  const catalogModel = models.find((candidate) => modelKey(candidate) === modelKey(model))
  const variants = catalogModel?.variants ?? []
  if (model.variant && !variants.includes(model.variant)) return [model.variant, ...variants]
  return variants
}

function createModelOptions(models: () => readonly CatalogModel[], value: () => ModelSelection) {
  const optionByKey = new Map<string, { value: string; label: string; model: ModelSelection }>()
  const fallbackByKey = new Map<string, { value: string; label: string; model: ModelSelection }>()
  const catalogOptions = createMemo(() =>
    models().map((model) => {
      const value = modelKey(model)
      const label = `${model.providerName} · ${model.modelName}`
      const previous = optionByKey.get(value)
      if (previous?.label === label) return previous
      const option = {
        value,
        label,
        model: { providerID: model.providerID, modelID: model.modelID } satisfies ModelSelection,
      }
      optionByKey.set(value, option)
      return option
    }),
  )

  return createMemo(() => {
    const current = value()
    const options = catalogOptions()
    const key = modelKey(current)
    if (options.some((option) => option.value === key)) return options

    let fallback = fallbackByKey.get(key)
    if (!fallback) {
      fallback = { value: key, label: modelLabel(current, models()), model: current }
      fallbackByKey.set(key, fallback)
    }
    return [fallback, ...options]
  })
}

function ModelFields(props: {
  value: ModelSelection
  models: readonly CatalogModel[]
  disabled?: boolean
  onChange: (model: ModelSelection) => void
}) {
  const options = createModelOptions(
    () => props.models,
    () => props.value,
  )
  const variants = createMemo(() => variantsFor(props.value, props.models))

  function changeModel(value: string) {
    const selected = props.models.find((model) => modelKey(model) === value)
    if (!selected) return
    props.onChange({ providerID: selected.providerID, modelID: selected.modelID })
  }

  function changeVariant(value: string) {
    props.onChange({
      providerID: props.value.providerID,
      modelID: props.value.modelID,
      ...(value ? { variant: value } : {}),
    })
  }

  return (
    <div class="model-control__fields">
      <label class="model-control__field">
        <span>{tr("composer.model")}</span>
        <select
          aria-label={tr("composer.model")}
          value={modelKey(props.value)}
          disabled={props.disabled}
          onChange={(event) => changeModel(event.currentTarget.value)}
        >
          <For each={options()}>{(option) => <option value={option.value}>{option.label}</option>}</For>
        </select>
      </label>
      <label class="model-control__field">
        <span>{tr("multi-agent.thinking-depth")}</span>
        <select
          aria-label={tr("multi-agent.thinking-depth")}
          value={props.value.variant ?? ""}
          disabled={props.disabled}
          onChange={(event) => changeVariant(event.currentTarget.value)}
        >
          <option value="">{variantLabel(undefined)}</option>
          <For each={variants()}>{(variant) => <option value={variant}>{variantLabel(variant)}</option>}</For>
        </select>
      </label>
    </div>
  )
}

export function ModelControl(props: {
  models: readonly CatalogModel[]
  value: ModelSelection
  disabled?: boolean
  onChange: (model: ModelSelection) => void
}) {
  const [opened, setOpened] = createSignal(false)
  const [mainValue, setMainValue] = createSignal(props.value)
  const currentLabel = createMemo(
    () => `${modelLabel(props.value, props.models)} · ${variantLabel(props.value.variant)}`,
  )

  function open() {
    setMainValue(props.value)
    setOpened(true)
  }

  function close() {
    setOpened(false)
  }

  function changeMain(model: ModelSelection) {
    setMainValue(model)
    props.onChange(model)
  }

  return (
    <div class="composer-model-control">
      <Button
        class="composer-model-trigger"
        size="small"
        variant="secondary"
        disabled={props.disabled}
        aria-label={tr("composer.configure-model")}
        onClick={open}
      >
        <SlidersHorizontal aria-hidden="true" />
        <span class="composer-model-trigger__copy">
          <strong>{tr("composer.model")}</strong>
          <small>{currentLabel()}</small>
        </span>
      </Button>
      <Dialog
        open={opened()}
        class="model-control-dialog"
        title={tr("composer.model-settings")}
        description={tr("composer.model-settings-description")}
        showClose
        onClose={close}
        footer={
          <Button size="small" variant="secondary" onClick={close}>
            {tr("composer.done")}
          </Button>
        }
      >
        <ModelFields value={mainValue()} models={props.models} disabled={props.disabled} onChange={changeMain} />
      </Dialog>
    </div>
  )
}
