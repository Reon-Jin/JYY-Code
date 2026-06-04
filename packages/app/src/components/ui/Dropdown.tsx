import { type JSX, createSignal, createEffect, onCleanup, For, Show } from 'solid-js'

interface DropdownItem {
  label: string
  value: string
  icon?: string // emoji or icon component
  shortcut?: string // keyboard shortcut text
  disabled?: boolean
  separator?: boolean // is this item a separator?
}

interface DropdownProps {
  items: DropdownItem[]
  selected?: string
  onSelect: (value: string) => void
  trigger: JSX.Element // custom trigger element
  align?: 'left' | 'right'
  width?: number
  class?: string
}

export function Dropdown(props: DropdownProps) {
  const [open, setOpen] = createSignal(false)
  let containerRef!: HTMLDivElement
  let menuRef!: HTMLDivElement

  // Close on outside click
  function handleClickOutside(e: MouseEvent) {
    if (containerRef && !containerRef.contains(e.target as Node)) {
      setOpen(false)
    }
  }

  createEffect(() => {
    if (open()) {
      document.addEventListener('mousedown', handleClickOutside)
    } else {
      document.removeEventListener('mousedown', handleClickOutside)
    }
  })

  onCleanup(() => document.removeEventListener('mousedown', handleClickOutside))

  const menuStyle = (): JSX.CSSProperties => ({
    position: 'absolute',
    top: '100%',
    [props.align === 'right' ? 'right' : 'left']: '0',
    'margin-top': 'var(--space-8)',
    'min-width': props.width ? `${props.width}px` : '220px',
    background: 'var(--clr-dark-surface)',
    'border-radius': 'var(--radius-generous)',
    'box-shadow': 'var(--whisper-shadow)',
    border: '1px solid var(--clr-border-dark)',
    padding: 'var(--space-4) 0',
    'z-index': '1000',
    'backdrop-filter': 'blur(12px)',
  })

  const itemStyle = (item: DropdownItem): JSX.CSSProperties => ({
    display: 'flex',
    'align-items': 'center',
    'justify-content': 'space-between',
    padding: '8px 14px',
    'font-size': '15px',
    'font-family': 'var(--font-sans)',
    color: item.disabled
      ? 'var(--clr-warm-silver)'
      : item.value === props.selected
        ? 'var(--clr-coral)'
        : 'var(--clr-ivory)',
    cursor: item.disabled ? 'not-allowed' : 'pointer',
    background:
      item.value === props.selected
        ? 'rgba(201, 100, 66, 0.10)'
        : 'transparent',
    transition: 'background 0.1s',
  })

  return (
    <div
      ref={containerRef}
      style={{ position: 'relative', display: 'inline-block' }}
      class={props.class}
    >
      <div onClick={() => setOpen((value) => !value)}>{props.trigger}</div>
      <Show when={open()}>
        <div ref={menuRef} style={menuStyle()}>
          <For each={props.items}>
            {(item) => (
              <>
                <Show when={item.separator}>
                  <div
                    style={{
                      height: '1px',
                      background: 'var(--clr-border-dark)',
                      margin: '4px 14px',
                    }}
                  />
                </Show>
                <Show when={!item.separator}>
                  <div
                    style={itemStyle(item)}
                    onClick={() => {
                      if (!item.disabled) {
                        props.onSelect(item.value)
                        setOpen(false)
                      }
                    }}
                  >
                    <span
                      style={{
                        display: 'flex',
                        'align-items': 'center',
                        gap: '8px',
                      }}
                    >
                      {item.icon && <span>{item.icon}</span>}
                      {item.label}
                    </span>
                    {item.shortcut && (
                      <span
                        style={{
                          'font-size': '12px',
                          color: 'var(--clr-stone-gray)',
                        }}
                      >
                        {item.shortcut}
                      </span>
                    )}
                  </div>
                </Show>
              </>
            )}
          </For>
        </div>
      </Show>
    </div>
  )
}
