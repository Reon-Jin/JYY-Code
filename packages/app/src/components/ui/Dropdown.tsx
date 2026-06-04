import {
  type JSX,
  createSignal,
  createEffect,
  onCleanup,
  splitProps,
  For,
  Show,
} from 'solid-js'

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

  const menuStyle: JSX.CSSProperties = {
    position: 'absolute',
    top: '100%',
    [props.align === 'right' ? 'right' : 'left']: '0',
    'margin-top': 'var(--space-8)',
    'min-width': props.width ? `${props.width}px` : '200px',
    background: 'var(--color-white)',
    'border-radius': 'var(--radius-standard)',
    'box-shadow': 'var(--shadow-card)',
    padding: 'var(--space-4) 0',
    'z-index': '1000',
    display: open() ? 'block' : 'none',
    'backdrop-filter': 'var(--nav-blur)',
  }

  const itemStyle = (item: DropdownItem): JSX.CSSProperties => ({
    display: 'flex',
    'align-items': 'center',
    'justify-content': 'space-between',
    padding: '6px 12px',
    'font-size': '14px',
    color: item.disabled
      ? 'var(--color-text-tertiary)'
      : item.value === props.selected
        ? 'var(--color-blue-apple)'
        : 'var(--color-text-primary)',
    cursor: item.disabled ? 'not-allowed' : 'pointer',
    background:
      item.value === props.selected ? 'rgba(0,113,227,0.06)' : 'transparent',
    transition: 'background 0.1s',
  })

  return (
    <div
      ref={containerRef}
      style={{ position: 'relative', display: 'inline-block' }}
      class={props.class}
    >
      <div onClick={() => setOpen(!open())}>{props.trigger}</div>
      <div ref={menuRef} style={menuStyle}>
        <For each={props.items}>
          {(item) => (
            <>
              <Show when={item.separator}>
                <div
                  style={{
                    height: '1px',
                    background: '#d2d2d7',
                    margin: '4px 12px',
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
                        color: 'var(--color-text-tertiary)',
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
    </div>
  )
}
