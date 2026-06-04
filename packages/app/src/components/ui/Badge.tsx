import { type JSX } from 'solid-js'

type BadgeVariant = 'default' | 'success' | 'warning' | 'error' | 'info'

interface BadgeProps {
  children: JSX.Element
  variant?: BadgeVariant
  dot?: boolean          // 前置小圆点
  count?: number         // 数字徽章
  class?: string
}

export function Badge(props: BadgeProps) {
  const variantColors: Record<BadgeVariant, { bg: string; text: string }> = {
    default: { bg: 'rgba(0,0,0,0.06)', text: 'var(--color-text-secondary)' },
    success: { bg: 'rgba(52,199,89,0.12)', text: '#1b7f3b' },
    warning: { bg: 'rgba(255,149,0,0.12)', text: '#b36b00' },
    error: { bg: 'rgba(255,59,48,0.12)', text: '#c41e1e' },
    info: { bg: 'rgba(0,113,227,0.12)', text: 'var(--color-blue-apple)' },
  }

  const colors = variantColors[props.variant || 'default']

  if (props.count !== undefined) {
    // Numeric badge (notification count)
    return (
      <span style={{
        display: 'inline-flex',
        'align-items': 'center',
        'justify-content': 'center',
        'min-width': '18px',
        height: '18px',
        padding: '0 5px',
        'border-radius': '980px',
        background: 'var(--color-blue-apple)',
        color: 'var(--color-white)',
        'font-size': '11px',
        'font-weight': '600',
        'line-height': '1',
        'letter-spacing': '-0.08px',
      }} class={props.class}>
        {props.count > 99 ? '99+' : props.count}
      </span>
    )
  }

  // Normal badge
  return (
    <span style={{
      display: 'inline-flex',
      'align-items': 'center',
      gap: '4px',
      padding: '2px 10px',
      'border-radius': '980px',
      background: colors.bg,
      color: colors.text,
      'font-size': '12px',
      'font-weight': '500',
      'line-height': '1.33',
      'letter-spacing': '-0.12px',
    }} class={props.class}>
      {props.dot && <span style={{
        width: '6px', height: '6px', 'border-radius': '50%',
        background: colors.text, 'flex-shrink': '0',
      }} />}
      {props.children}
    </span>
  )
}
