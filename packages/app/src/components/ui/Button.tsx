import { type JSX, splitProps } from 'solid-js'

type ButtonVariant = 'primary' | 'outline' | 'dark' | 'ghost' | 'link'
type ButtonSize = 'sm' | 'md' | 'lg'

interface ButtonProps extends JSX.ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant
  size?: ButtonSize
  pill?: boolean      // 980px pill radius
  loading?: boolean
  children: JSX.Element
}

export function Button(props: ButtonProps) {
  const [local, rest] = splitProps(props, [
    'variant',
    'size',
    'pill',
    'loading',
    'class',
    'children',
  ])

  const baseStyles: JSX.CSSProperties = {
    display: 'inline-flex',
    'align-items': 'center',
    'justify-content': 'center',
    gap: 'var(--space-8)',
    'font-family': 'var(--font-text)',
    'font-size':
      local.size === 'sm' ? '14px' : local.size === 'lg' ? '18px' : '17px',
    'font-weight': '400',
    'line-height': local.variant === 'link' ? '2.41' : '1',
    'letter-spacing': '-0.374px',
    cursor: 'pointer',
    transition: 'all 0.15s ease',
    border: 'none',
    outline: 'none',
    position: 'relative',
    'border-radius': local.pill ? '980px' : 'var(--radius-standard)',
    padding:
      local.size === 'sm'
        ? '4px 12px'
        : local.size === 'lg'
          ? '11px 20px'
          : '8px 15px',
  }

  // Variant-specific styles — only non-hover properties
  const variantStyles: Record<ButtonVariant, JSX.CSSProperties> = {
    primary: {
      background: 'var(--color-blue-apple)',
      color: 'var(--color-white)',
    },
    outline: {
      background: 'transparent',
      color: 'var(--color-blue-apple)',
      border: '1px solid var(--color-blue-apple)',
    },
    dark: {
      background: 'var(--color-black-near)',
      color: 'var(--color-white)',
    },
    ghost: {
      background: 'transparent',
      color: 'var(--color-text-primary)',
    },
    link: {
      background: 'transparent',
      color: 'var(--color-blue-link)',
      padding: '4px 16px',
      'font-size': '14px',
      'letter-spacing': '-0.224px',
    },
  }

  const variant = local.variant || 'primary'

  return (
    <>
      <style>{`
        button[data-variant="primary"]:hover { opacity: 0.88; }
        button[data-variant="primary"]:active { background: var(--color-button-active); }
        button[data-variant="outline"]:hover { background: rgba(0,113,227,0.06); }
        button[data-variant="outline"]:active { background: rgba(0,113,227,0.12); }
        button[data-variant="dark"]:hover { opacity: 0.88; }
        button[data-variant="dark"]:active { opacity: 0.76; }
        button[data-variant="ghost"]:hover { background: rgba(0,0,0,0.04); }
        button[data-variant="ghost"]:active { background: rgba(0,0,0,0.08); }
        button[data-variant="link"]:hover { text-decoration: underline; }
        button[data-variant="link"]:active { opacity: 0.7; }
        button:disabled { opacity: 0.4; cursor: not-allowed; }
        .spinner {
          display: inline-block;
          width: 16px;
          height: 16px;
          border: 2px solid currentColor;
          border-right-color: transparent;
          border-radius: 50%;
          animation: spin 0.6s linear infinite;
        }
        @keyframes spin {
          to { transform: rotate(360deg); }
        }
      `}</style>
      <button
        data-variant={variant}
        style={{ ...baseStyles, ...variantStyles[variant] }}
        class={local.class || ''}
        disabled={local.loading || rest.disabled}
        {...rest}
      >
        {local.loading && <span class="spinner" />}
        {local.children}
      </button>
    </>
  )
}
