import { type JSX, splitProps, createSignal } from 'solid-js'

interface InputProps extends JSX.InputHTMLAttributes<HTMLInputElement> {
  label?: string
  error?: string
  variant?: 'default' | 'search'
}

export function Input(props: InputProps) {
  const [local, rest] = splitProps(props, ['label', 'error', 'variant', 'class'])
  const [focused, setFocused] = createSignal(false)

  const isSearch = local.variant === 'search'
  const hasError = Boolean(local.error)

  const containerStyle: JSX.CSSProperties = {
    display: 'flex',
    'flex-direction': 'column',
    gap: 'var(--space-6)',
    width: '100%',
  }

  const labelStyle: JSX.CSSProperties = {
    'font-size': '14px',
    'font-weight': '500',
    color: 'var(--clr-stone-gray)',
  }

  const inputStyle: JSX.CSSProperties = {
    width: '100%',
    background: isSearch
      ? 'var(--color-filter-bg)'
      : 'var(--clr-dark-surface)',
    color: 'var(--clr-ivory)',
    border: hasError
      ? '1px solid var(--clr-error)'
      : focused()
        ? '1px solid var(--clr-focus-blue)'
        : '1px solid var(--clr-border-dark)',
    padding: '10px 14px',
    'border-radius': isSearch
      ? 'var(--radius-generous)'
      : 'var(--radius-generous)',
    'font-family': 'var(--font-sans)',
    'font-size': '16px',
    'font-weight': '400',
    'line-height': '1.60',
    outline: 'none',
    transition: 'border-color 0.15s, box-shadow 0.15s',
    'box-sizing': 'border-box',
    'box-shadow':
      focused() && !hasError
        ? '0 0 0 3px rgba(56, 152, 236, 0.25)'
        : hasError
          ? '0 0 0 3px rgba(181, 51, 51, 0.20)'
          : 'none',
  }

  const errorStyle: JSX.CSSProperties = {
    'font-size': '12px',
    color: 'var(--clr-error)',
    'margin-top': '4px',
  }

  return (
    <div style={containerStyle}>
      {local.label && <label style={labelStyle}>{local.label}</label>}
      <input
        style={inputStyle}
        class={local.class || ''}
        onFocus={() => setFocused(true)}
        onBlur={() => setFocused(false)}
        {...rest}
      />
      {hasError && <span style={errorStyle}>{local.error}</span>}
    </div>
  )
}

/* ------------------------------------------------------------------ */
/*  TextArea                                                            */
/* ------------------------------------------------------------------ */

interface TextAreaProps
  extends JSX.TextareaHTMLAttributes<HTMLTextAreaElement> {
  label?: string
  error?: string
}

export function TextArea(props: TextAreaProps) {
  const [local, rest] = splitProps(props, ['label', 'error', 'class'])
  const [focused, setFocused] = createSignal(false)

  const hasError = Boolean(local.error)

  const containerStyle: JSX.CSSProperties = {
    display: 'flex',
    'flex-direction': 'column',
    gap: 'var(--space-6)',
    width: '100%',
  }

  const labelStyle: JSX.CSSProperties = {
    'font-size': '14px',
    'font-weight': '500',
    color: 'var(--clr-stone-gray)',
  }

  const textareaStyle: JSX.CSSProperties = {
    width: '100%',
    'min-height': '80px',
    background: 'var(--clr-dark-surface)',
    color: 'var(--clr-ivory)',
    border: hasError
      ? '1px solid var(--clr-error)'
      : focused()
        ? '1px solid var(--clr-focus-blue)'
        : '1px solid var(--clr-border-dark)',
    padding: '10px 14px',
    'border-radius': 'var(--radius-generous)',
    'font-family': 'var(--font-sans)',
    'font-size': '16px',
    'font-weight': '400',
    'line-height': '1.60',
    outline: 'none',
    resize: 'vertical',
    transition: 'border-color 0.15s, box-shadow 0.15s',
    'box-sizing': 'border-box',
    'box-shadow':
      focused() && !hasError
        ? '0 0 0 3px rgba(56, 152, 236, 0.25)'
        : hasError
          ? '0 0 0 3px rgba(181, 51, 51, 0.20)'
          : 'none',
  }

  const errorStyle: JSX.CSSProperties = {
    'font-size': '12px',
    color: 'var(--clr-error)',
    'margin-top': '4px',
  }

  return (
    <div style={containerStyle}>
      {local.label && <label style={labelStyle}>{local.label}</label>}
      <textarea
        style={textareaStyle}
        class={local.class || ''}
        onFocus={() => setFocused(true)}
        onBlur={() => setFocused(false)}
        {...rest}
      />
      {hasError && <span style={errorStyle}>{local.error}</span>}
    </div>
  )
}
