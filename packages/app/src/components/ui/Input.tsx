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
    'font-weight': '600',
    color: 'var(--color-text-primary)',
    'letter-spacing': '-0.224px',
  }

  const inputStyle: JSX.CSSProperties = {
    width: '100%',
    background: isSearch ? 'var(--color-filter-bg)' : 'var(--color-white)',
    color: 'var(--color-text-primary)',
    border: hasError
      ? '1px solid #ff3b30'
      : focused()
        ? '1px solid var(--color-blue-apple)'
        : isSearch
          ? '3px solid rgba(0,0,0,0.04)'
          : '1px solid #d2d2d7',
    padding: isSearch ? '6px 14px' : '10px 14px',
    'border-radius': isSearch
      ? 'var(--radius-search)'
      : 'var(--radius-standard)',
    'font-family': 'var(--font-text)',
    'font-size': '17px',
    'font-weight': '400',
    'line-height': '1.47',
    'letter-spacing': '-0.374px',
    outline: 'none',
    transition: 'border-color 0.15s, box-shadow 0.15s',
    'box-sizing': 'border-box',
    'box-shadow': focused() && !hasError
      ? '0 0 0 3px rgba(0,113,227,0.2)'
      : hasError
        ? '0 0 0 3px rgba(255,59,48,0.2)'
        : 'none',
  }

  const errorStyle: JSX.CSSProperties = {
    'font-size': '11px',
    color: '#ff3b30',
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
/*  TextArea                                                           */
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
    'font-weight': '600',
    color: 'var(--color-text-primary)',
    'letter-spacing': '-0.224px',
  }

  const textareaStyle: JSX.CSSProperties = {
    width: '100%',
    'min-height': '80px',
    background: 'var(--color-white)',
    color: 'var(--color-text-primary)',
    border: hasError
      ? '1px solid #ff3b30'
      : focused()
        ? '1px solid var(--color-blue-apple)'
        : '1px solid #d2d2d7',
    padding: '10px 14px',
    'border-radius': 'var(--radius-standard)',
    'font-family': 'var(--font-text)',
    'font-size': '17px',
    'font-weight': '400',
    'line-height': '1.47',
    'letter-spacing': '-0.374px',
    outline: 'none',
    resize: 'vertical',
    transition: 'border-color 0.15s, box-shadow 0.15s',
    'box-sizing': 'border-box',
    'box-shadow': focused() && !hasError
      ? '0 0 0 3px rgba(0,113,227,0.2)'
      : hasError
        ? '0 0 0 3px rgba(255,59,48,0.2)'
        : 'none',
  }

  const errorStyle: JSX.CSSProperties = {
    'font-size': '11px',
    color: '#ff3b30',
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
