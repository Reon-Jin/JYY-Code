import { type JSX, splitProps } from 'solid-js'

type ButtonVariant = 'primary' | 'outline' | 'dark' | 'ghost' | 'link'
type ButtonSize = 'sm' | 'md' | 'lg'

interface ButtonProps extends JSX.ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant
  size?: ButtonSize
  pill?: boolean
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
    'font-family': 'var(--font-sans)',
    'font-size':
      local.size === 'sm' ? '14px' : local.size === 'lg' ? '18px' : '16px',
    'font-weight': '500',
    'line-height': '1',
    cursor: 'pointer',
    transition: 'all 0.15s ease',
    border: 'none',
    outline: 'none',
    position: 'relative',
    'border-radius': local.pill ? '980px' : 'var(--radius-generous)',
    padding:
      local.size === 'sm'
        ? '6px 14px'
        : local.size === 'lg'
          ? '12px 24px'
          : '8px 18px',
  }

  // Claude button variants
  const variantStyles: Record<ButtonVariant, JSX.CSSProperties> = {
    primary: {
      // Brand Terracotta CTA
      background: 'var(--clr-terracotta)',
      color: 'var(--clr-ivory)',
      'box-shadow': 'var(--ring-terracotta)',
    },
    outline: {
      // Warm Sand secondary
      background: 'var(--clr-dark-surface)',
      color: 'var(--clr-warm-silver)',
      'box-shadow': 'var(--ring-dark)',
    },
    dark: {
      // Dark Primary
      background: 'var(--clr-near-black)',
      color: 'var(--clr-warm-silver)',
      border: '1px solid var(--clr-dark-surface)',
    },
    ghost: {
      // Transparent with hover
      background: 'transparent',
      color: 'var(--clr-stone-gray)',
    },
    link: {
      // Text link style
      background: 'transparent',
      color: 'var(--clr-coral)',
      padding: '4px 16px',
      'font-size': '14px',
    },
  }

  const variant = local.variant || 'primary'

  return (
    <>
      <style>{`
        button[data-variant="primary"]:hover { opacity: 0.88; }
        button[data-variant="primary"]:active {
          box-shadow: inset 0px 0px 0px 1px rgba(255,255,255,0.15);
        }
        button[data-variant="outline"]:hover {
          color: var(--clr-ivory);
          background: #3a3a37;
          box-shadow: var(--ring-deep);
        }
        button[data-variant="outline"]:active {
          box-shadow: inset 0px 0px 0px 1px rgba(255,255,255,0.10);
        }
        button[data-variant="dark"]:hover { opacity: 0.85; }
        button[data-variant="dark"]:active { opacity: 0.72; }
        button[data-variant="ghost"]:hover {
          color: var(--clr-ivory);
          background: rgba(255,255,255,0.06);
        }
        button[data-variant="ghost"]:active {
          background: rgba(255,255,255,0.10);
        }
        button[data-variant="link"]:hover { color: var(--clr-terracotta); }
        button[data-variant="link"]:active { opacity: 0.7; }
        button:disabled { opacity: 0.35; cursor: not-allowed; }
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
