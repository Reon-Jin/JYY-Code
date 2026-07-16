import { tr } from "../../i18n/i18n-context"
import { For, Show } from "solid-js"
import type { CatalogModel, ModelSelection } from "./model-catalog"

function valueOf(model: ModelSelection) {
  return `${model.providerID}/${model.modelID}`
}

export function ModelSelect(props: {
  models: readonly CatalogModel[]
  value: ModelSelection
  disabled?: boolean
  onChange: (model: ModelSelection) => void
}) {
  return (
    <label class="composer-select composer-select--model">
      <span>{tr("composer.model")}</span>
      <select
        aria-label={tr("composer.model")}
        value={valueOf(props.value)}
        disabled={props.disabled}
        onChange={(event) => {
          const model = props.models.find((candidate) => valueOf(candidate) === event.currentTarget.value)
          if (model) props.onChange({ providerID: model.providerID, modelID: model.modelID })
        }}
      >
        <Show when={!props.models.some((model) => valueOf(model) === valueOf(props.value))}>
          <option value={valueOf(props.value)}>
            {props.value.providerID} · {props.value.modelID}
          </option>
        </Show>
        <For each={props.models}>
          {(model) => (
            <option value={valueOf(model)}>
              {model.providerName} · {model.modelName}
            </option>
          )}
        </For>
      </select>
    </label>
  )
}
