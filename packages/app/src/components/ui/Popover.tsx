import { type JSX, createSignal, createEffect, onCleanup } from 'solid-js'

interface PopoverProps {
  trigger: JSX.Element
  children: JSX.Element
  position?: 'top' | 'bottom' | 'left' | 'right'
  align?: 'start' | 'center' | 'end'
  width?: number
  class?: string
}

export function Popover(props: PopoverProps) {
  const [open, setOpen] = createSignal(false)
  let containerRef!: HTMLDivElement

  function handleClickOutside(e: MouseEvent) {
    if (containerRef && !containerRef.contains(e.target as Node)) {
      setOpen(false)
    }
  }

  createEffect(() => {
    if (open()) document.addEventListener('mousedown', handleClickOutside)
    else document.removeEventListener('mousedown', handleClickOutside)
  })
  onCleanup(() => document.removeEventListener('mousedown', handleClickOutside))

  const popoverStyle = (): JSX.CSSProperties => ({
    position: 'absolute',
    top: (props.position ?? 'bottom') === 'bottom' ? '100%' : 'auto',
    bottom: props.position === 'top' ? '100%' : 'auto',
    left: props.align === 'center' ? '50%' : props.align === 'end' ? 'auto' : '0',
    right: props.align === 'end' ? '0' : 'auto',
    transform: props.align === 'center' ? 'translateX(-50%)' : 'none',
    'margin-top': (props.position ?? 'bottom') === 'bottom' ? 'var(--space-8)' : '0',
    'margin-bottom': props.position === 'top' ? 'var(--space-8)' : '0',
    width: props.width ? `${props.width}px` : '280px',
    background: 'var(--clr-dark-surface)',
    'border-radius': 'var(--radius-generous)',
    'box-shadow': 'var(--whisper-shadow)',
    border: '1px solid var(--clr-border-dark)',
    padding: '16px 18px',
    'z-index': '1000',
  })

  return (
    <div
      ref={containerRef}
      style={{ position: 'relative', display: 'inline-block' }}
      class={props.class}
    >
      <div onClick={() => setOpen((value) => !value)}>{props.trigger}</div>
      {open() && <div style={popoverStyle()}>{props.children}</div>}
    </div>
  )
}
