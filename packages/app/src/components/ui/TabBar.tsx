import { type JSX, For } from 'solid-js'

interface Tab {
  id: string
  label: string
  icon?: string
}

interface TabBarProps {
  tabs: Tab[]
  activeTab: string
  onChange: (tabId: string) => void
  class?: string
}

export function TabBar(props: TabBarProps) {
  return (
    <div style={{
      display: 'flex',
      'border-bottom': '1px solid #d2d2d7',
      gap: '0',
    }} class={props.class}>
      <For each={props.tabs}>
        {(tab) => (
          <button
            onClick={() => props.onChange(tab.id)}
            style={{
              padding: '8px 16px',
              border: 'none',
              background: 'none',
              'font-family': 'var(--font-text)',
              'font-size': '14px',
              'font-weight': props.activeTab === tab.id ? '600' : '400',
              color: props.activeTab === tab.id ? 'var(--color-blue-apple)' : 'var(--color-text-secondary)',
              'border-bottom': props.activeTab === tab.id ? '2px solid var(--color-blue-apple)' : '2px solid transparent',
              cursor: 'pointer',
              transition: 'all 0.15s',
              display: 'flex',
              'align-items': 'center',
              gap: '6px',
              'margin-bottom': '-1px',
            }}
          >
            {tab.icon && <span>{tab.icon}</span>}
            {tab.label}
          </button>
        )}
      </For>
    </div>
  )
}
