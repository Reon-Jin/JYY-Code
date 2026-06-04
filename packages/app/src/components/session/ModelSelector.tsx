import { Dropdown } from '../ui/Dropdown'
import type { ModelInfo } from '../../types/models'

interface Props {
  selected: string
  models: ModelInfo[]
  onChange: (modelId: string) => void
}

export function ModelSelector(props: Props) {
  const items = props.models.map(m => ({
    label: m.name,
    value: m.id,
    icon: getProviderIcon(m.provider),
  }))

  const selectedModel = props.models.find(m => m.id === props.selected)
  const triggerLabel = selectedModel?.name || '选择模型'

  return (
    <Dropdown
      items={items}
      selected={props.selected}
      onSelect={props.onChange}
      width={200}
      trigger={
        <button style={{
          display: 'flex',
          'align-items': 'center',
          gap: 'var(--space-8)',
          padding: '4px 12px',
          'border-radius': 'var(--radius-standard)',
          border: 'none',
          background: 'rgba(255,255,255,0.12)',
          color: 'var(--color-text-white)',
          'font-size': '13px',
          cursor: 'pointer',
          transition: 'background 0.15s',
          'white-space': 'nowrap',
        }}>
          <span style={{ 'font-size': '16px' }}>🧠</span>
          <span>{triggerLabel}</span>
          <span style={{ 'font-size': '10px', 'margin-left': '2px' }}>▾</span>
        </button>
      }
    />
  )
}

function getProviderIcon(provider: string): string {
  const icons: Record<string, string> = {
    openai: '🔵',
    anthropic: '🟠',
    google: '🟢',
    deepseek: '🔷',
    meta: '🟣',
  }
  return icons[provider.toLowerCase()] || '🤖'
}
