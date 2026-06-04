import { type JSX } from 'solid-js'

interface ProgressBarProps {
  value: number       // 0-100
  max?: number
  showLabel?: boolean
  size?: 'sm' | 'md'
  variant?: 'default' | 'success' | 'warning'
  class?: string
}

export function ProgressBar(props: ProgressBarProps) {
  const max = props.max ?? 100
  const percentage = Math.min(100, Math.max(0, (props.value / max) * 100))
  const height = props.size === 'sm' ? '4px' : '6px'

  const variantColors = {
    default: 'var(--color-blue-apple)',
    success: '#34c759',
    warning: '#ff9500',
  }

  return (
    <div class={props.class} style={{ width: '100%' }}>
      <div style={{
        width: '100%',
        height,
        'border-radius': 'var(--radius-micro)',
        background: 'rgba(0,0,0,0.08)',
        overflow: 'hidden',
      }}>
        <div style={{
          width: `${percentage}%`,
          height: '100%',
          'border-radius': 'var(--radius-micro)',
          background: variantColors[props.variant || 'default'],
          transition: 'width 0.5s ease',
        }} />
      </div>
      {props.showLabel && (
        <div style={{
          'text-align': 'right',
          'font-size': '12px',
          color: 'var(--color-text-tertiary)',
          'margin-top': '4px',
        }}>
          {Math.round(percentage)}% ({props.value}/{max})
        </div>
      )}
    </div>
  )
}
