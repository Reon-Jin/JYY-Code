import { type JSX } from 'solid-js'

type BadgeVariant = 'default' | 'success' | 'warning' | 'error' | 'info'

interface BadgeProps {
  children?: JSX.Element
  variant?: BadgeVariant
  dot?: boolean
  count?: number
  class?: string
}

export function Badge(props: BadgeProps) {
  const variantColors: Record<BadgeVariant, { bg: string; text: string }> = {
    default: { bg: 'rgba(176, 174, 165, 0.14)', text: 'var(--clr-warm-silver)' },
    success: { bg: 'rgba(138, 154, 98, 0.16)',  text: '#8a9a62' },
    warning: { bg: 'rgba(201, 100, 66, 0.14)',   text: 'var(--clr-coral)' },
    error:   { bg: 'rgba(181, 51, 51, 0.18)',    text: 'var(--clr-error)' },
    info:    { bg: 'rgba(56, 152, 236, 0.14)',   text: 'var(--clr-focus-blue)' },
  }

  const colors = variantColors[props.variant || 'default']

  if (props.count !== undefined) {
    return (
      <span
        style={{
          display: 'inline-flex',
          'align-items': 'center',
          'justify-content': 'center',
          'min-width': '20px',
          height: '20px',
          padding: '0 6px',
          'border-radius': '999px',
          background: 'var(--clr-terracotta)',
          color: 'var(--clr-ivory)',
          'font-size': '11px',
          'font-weight': '500',
          'line-height': '1',
        }}
        class={props.class}
      >
        {props.count > 99 ? '99+' : props.count}
      </span>
    )
  }

  return (
    <span
      style={{
        display: 'inline-flex',
        'align-items': 'center',
        gap: '4px',
        padding: '2px 10px',
        'border-radius': 'var(--radius-high)',
        background: colors.bg,
        color: colors.text,
        'font-family': 'var(--font-sans)',
        'font-size': '12px',
        'font-weight': '500',
        'line-height': '1.60',
        'letter-spacing': '0.12px',
      }}
      class={props.class}
    >
      {props.dot && (
        <span
          style={{
            width: '6px',
            height: '6px',
            'border-radius': '50%',
            background: colors.text,
            'flex-shrink': '0',
          }}
        />
      )}
      {props.children}
    </span>
  )
}
