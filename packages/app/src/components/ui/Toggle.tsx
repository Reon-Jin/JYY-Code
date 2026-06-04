import { type JSX } from 'solid-js'

interface ToggleProps {
  checked: boolean
  onChange: (checked: boolean) => void
  disabled?: boolean
  label?: string
  size?: 'sm' | 'md'
}

export function Toggle(props: ToggleProps) {
  const isSm = props.size === 'sm'
  const isDisabled = Boolean(props.disabled)

  const trackStyle = (): JSX.CSSProperties => ({
    width: isSm ? '36px' : '48px',
    height: isSm ? '20px' : '28px',
    'border-radius': '980px',
    background: props.checked
      ? 'var(--clr-terracotta)'
      : 'rgba(176, 174, 165, 0.28)',
    cursor: isDisabled ? 'not-allowed' : 'pointer',
    position: 'relative',
    transition: 'background 0.25s ease',
    'flex-shrink': '0',
    opacity: isDisabled ? 0.4 : 1,
  })

  const thumbStyle = (): JSX.CSSProperties => ({
    width: isSm ? '16px' : '24px',
    height: isSm ? '16px' : '24px',
    'border-radius': '50%',
    background: '#ffffff',
    'box-shadow': '0 2px 4px rgba(0,0,0,0.2)',
    position: 'absolute',
    top: '2px',
    left: props.checked ? (isSm ? '18px' : '22px') : '2px',
    transition: 'left 0.25s ease',
  })

  const labelStyle: JSX.CSSProperties = {
    'font-size': '14px',
    'font-family': 'var(--font-sans)',
    color: isDisabled
      ? 'var(--clr-warm-silver)'
      : 'var(--clr-stone-gray)',
    'user-select': 'none',
  }

  return (
    <label
      style={{
        display: 'inline-flex',
        'align-items': 'center',
        gap: 'var(--space-8)',
        cursor: isDisabled ? 'not-allowed' : 'pointer',
      }}
    >
      <div
        style={trackStyle()}
        onClick={() => !isDisabled && props.onChange(!props.checked)}
        role="switch"
        aria-checked={props.checked}
        aria-disabled={isDisabled}
      >
        <div style={thumbStyle()} />
      </div>
      {props.label && <span style={labelStyle}>{props.label}</span>}
    </label>
  )
}
