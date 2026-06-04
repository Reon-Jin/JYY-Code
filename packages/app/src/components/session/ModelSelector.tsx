import { Dropdown } from '../ui/Dropdown'
import type { ModelInfo } from '../../types/models'

interface Props {
  selected: string
  models: ModelInfo[]
  onChange: (modelId: string) => void
}

export function ModelSelector(props: Props) {
  const items = props.models.map((model) => ({
    label: model.name,
    value: model.id,
    icon: model.connected === false ? 'off' : 'on',
  }))

  const selectedModel = () => props.models.find((model) => model.id === props.selected)

  return (
    <Dropdown
      items={items}
      selected={props.selected}
      onSelect={props.onChange}
      width={280}
      align="right"
      trigger={
        <button class="toolbar-control model-control" title="Select model">
          <span class="status-dot" data-state={selectedModel()?.connected === false ? 'off' : 'on'} />
          <span class="model-name">{selectedModel()?.name || 'Select model'}</span>
          <span class="chevron">v</span>
        </button>
      }
    />
  )
}
