import { createMemo, For } from "solid-js"
import type { CatalogModel, ModelSelection } from "./model-catalog"

export function ModelControl(props: {
  models: readonly CatalogModel[]
  value: ModelSelection
  disabled?: boolean
  onChange: (model: ModelSelection) => void
}) {
  const key = (model: ModelSelection) => `${model.providerID}/${model.modelID}/${model.variant ?? ""}`
  const options = createMemo(() => {
    const available = props.models.flatMap((model) => [
      { value: key(model), label: `${model.providerName} · ${model.modelName}`, model },
      ...model.variants.map((variant) => ({
        value: key({ ...model, variant }),
        label: `${model.providerName} · ${model.modelName} · ${variant}`,
        model: { providerID: model.providerID, modelID: model.modelID, variant },
      })),
    ])
    if (available.some((option) => option.value === key(props.value))) return available
    return [
      {
        value: key(props.value),
        label: `${props.value.providerID}/${props.value.modelID}${props.value.variant ? ` · ${props.value.variant}` : ""}`,
        model: props.value,
      },
      ...available,
    ]
  })

  return (
    <select
      class="composer-model-control"
      aria-label="主模型"
      value={key(props.value)}
      disabled={props.disabled}
      onChange={(event) => {
        const selected = options().find((option) => option.value === event.currentTarget.value)
        if (selected) props.onChange(selected.model)
      }}
    >
      <For each={options()}>{(option) => <option value={option.value}>{option.label}</option>}</For>
    </select>
  )
}
