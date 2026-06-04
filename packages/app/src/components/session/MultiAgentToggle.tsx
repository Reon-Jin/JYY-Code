import { Toggle } from '../ui/Toggle'

interface Props {
  enabled: boolean
  onChange: (enabled: boolean) => void
}

export function MultiAgentToggle(props: Props) {
  return (
    <div style={{
      display: 'flex',
      'align-items': 'center',
      gap: 'var(--space-8)',
      padding: '4px 12px',
      'border-radius': 'var(--radius-standard)',
      background: 'rgba(255,255,255,0.12)',
      cursor: 'pointer',
    }}>
      <span style={{ 'font-size': '16px' }}>👥</span>
      <span style={{
        'font-size': '13px',
        color: 'var(--color-text-white)',
        'font-weight': '500',
      }}>
        Multi
      </span>
      <Toggle
        checked={props.enabled}
        onChange={props.onChange}
        size="sm"
      />
    </div>
  )
}
