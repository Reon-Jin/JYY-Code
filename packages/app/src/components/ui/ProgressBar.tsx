import { type JSX } from 'solid-js'

interface ProgressBarProps {
  value: number
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
    default: 'var(--clr-terracotta)',
    success: '#8a9a62',
    warning: 'var(--clr-coral)',
  }

  return (
    <div class={props.class} style={{ width: '100%' }}>
      <div
        style={{
          width: '100%',
          height,
          'border-radius': '3px',
          background: 'rgba(176, 174, 165, 0.14)',
          overflow: 'hidden',
        }}
      >
        <div
          style={{
            width: `${percentage}%`,
            height: '100%',
            'border-radius': '3px',
            background: variantColors[props.variant || 'default'],
            transition: 'width 0.5s ease',
          }}
        />
      </div>
      {props.showLabel && (
        <div
          style={{
            'text-align': 'right',
            'font-size': '12px',
            'font-family': 'var(--font-sans)',
            color: 'var(--clr-stone-gray)',
            'margin-top': '4px',
          }}
        >
          {Math.round(percentage)}% ({props.value}/{max})
        </div>
      )}
    </div>
  )
}
