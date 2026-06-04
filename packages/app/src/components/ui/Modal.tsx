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
  // Close on Escape
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
    background: 'rgba(0,0,0,0.4)',
    display: 'flex',
    'align-items': 'center',
    'justify-content': 'center',
    'z-index': '10000',
    'backdrop-filter': 'blur(4px)',
    animation: 'fadeIn 0.2s ease',
  }

  const modalStyle: JSX.CSSProperties = {
    background: 'var(--color-white)',
    'border-radius': 'var(--radius-feature)',
    'box-shadow': 'var(--shadow-card)',
    'max-width': props.width ? `${props.width}px` : '560px',
    'max-height': '80vh',
    width: '90%',
    display: 'flex',
    'flex-direction': 'column',
    animation: 'scaleIn 0.25s ease',
  }

  const headerStyle: JSX.CSSProperties = {
    display: 'flex',
    'align-items': 'center',
    'justify-content': 'space-between',
    padding: 'var(--space-20) var(--space-24) var(--space-10)',
    'border-bottom': props.title ? '1px solid #d2d2d7' : 'none',
  }

  const bodyStyle: JSX.CSSProperties = {
    padding: 'var(--space-14) var(--space-24)',
    'overflow-y': 'auto',
    flex: '1',
  }

  const footerStyle: JSX.CSSProperties = {
    padding: 'var(--space-10) var(--space-24) var(--space-20)',
    'border-top': '1px solid #d2d2d7',
  }

  return (
    <Show when={props.open}>
      <div
        style={overlayStyle}
        onClick={(e) => e.target === e.currentTarget && props.onClose()}
      >
        <div style={modalStyle}>
          <div style={headerStyle}>
            {props.title && <h2 class="text-card-title">{props.title}</h2>}
            <button
              onClick={props.onClose}
              style={{
                background: 'none',
                border: 'none',
                'font-size': '20px',
                color: 'var(--color-text-tertiary)',
                cursor: 'pointer',
                padding: '4px',
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
        @keyframes scaleIn { from { opacity: 0; transform: scale(0.95); } to { opacity: 1; transform: scale(1); } }
      `}</style>
    </Show>
  )
}
