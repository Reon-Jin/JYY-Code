import { type JSX, createEffect, onCleanup, Show } from 'solid-js'

interface ModalProps {
  open: boolean
  onClose: () => void
  title?: string
  children: JSX.Element
  width?: number
  footer?: JSX.Element
}

export function Modal(props: ModalProps) {
  function handleKeyDown(e: KeyboardEvent) {
    if (e.key === 'Escape') props.onClose()
  }

  createEffect(() => {
    if (props.open) {
      document.addEventListener('keydown', handleKeyDown)
      document.body.style.overflow = 'hidden'
    } else {
      document.body.style.overflow = ''
    }
  })

  onCleanup(() => {
    document.removeEventListener('keydown', handleKeyDown)
    document.body.style.overflow = ''
  })

  const overlayStyle: JSX.CSSProperties = {
    position: 'fixed',
    inset: '0',
    background: 'rgba(20, 20, 19, 0.64)',
    display: 'flex',
    'align-items': 'center',
    'justify-content': 'center',
    'z-index': '10000',
    'backdrop-filter': 'blur(4px)',
    animation: 'fadeIn 0.15s ease',
  }

  const modalStyle: JSX.CSSProperties = {
    background: 'var(--clr-dark-surface)',
    'border-radius': 'var(--radius-very)',
    border: '1px solid var(--clr-border-dark)',
    'box-shadow': 'var(--whisper-shadow)',
    'max-width': props.width ? `${props.width}px` : '560px',
    'max-height': '80vh',
    width: '90%',
    display: 'flex',
    'flex-direction': 'column',
    animation: 'scaleIn 0.2s ease',
  }

  const headerStyle: JSX.CSSProperties = {
    display: 'flex',
    'align-items': 'center',
    'justify-content': 'space-between',
    padding: '20px 24px 10px',
    'border-bottom': props.title ? '1px solid var(--clr-border-dark)' : 'none',
  }

  const bodyStyle: JSX.CSSProperties = {
    padding: '16px 24px',
    'overflow-y': 'auto',
    flex: '1',
    color: 'var(--clr-stone-gray)',
  }

  const footerStyle: JSX.CSSProperties = {
    padding: '12px 24px 20px',
    'border-top': props.footer ? '1px solid var(--clr-border-dark)' : 'none',
  }

  return (
    <Show when={props.open}>
      <div
        style={overlayStyle}
        onClick={(e) => e.target === e.currentTarget && props.onClose()}
      >
        <div style={modalStyle}>
          <div style={headerStyle}>
            {props.title && (
              <h2
                style={{
                  'font-family': 'var(--font-serif)',
                  'font-size': '25px',
                  'font-weight': '500',
                  'line-height': '1.20',
                  color: 'var(--clr-ivory)',
                  margin: '0',
                }}
              >
                {props.title}
              </h2>
            )}
            <button
              onClick={props.onClose}
              style={{
                background: 'none',
                border: 'none',
                'font-size': '20px',
                color: 'var(--clr-warm-silver)',
                cursor: 'pointer',
                padding: '4px 8px',
                'border-radius': 'var(--radius-comfortable)',
              }}
            >
              ✕
            </button>
          </div>
          <div style={bodyStyle}>{props.children}</div>
          {props.footer && <div style={footerStyle}>{props.footer}</div>}
        </div>
      </div>
      <style>{`
        @keyframes fadeIn { from { opacity: 0; } to { opacity: 1; } }
        @keyframes scaleIn { from { opacity: 0; transform: scale(0.96); } to { opacity: 1; transform: scale(1); } }
      `}</style>
    </Show>
  )
}
