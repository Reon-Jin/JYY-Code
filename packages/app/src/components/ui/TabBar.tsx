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
    <div
      style={{
        display: 'flex',
        'border-bottom': '1px solid var(--clr-border-dark)',
        gap: '0',
      }}
      class={props.class}
    >
      <For each={props.tabs}>
        {(tab) => (
          <button
            onClick={() => props.onChange(tab.id)}
            style={{
              padding: '10px 18px',
              border: 'none',
              background: 'none',
              'font-family': 'var(--font-sans)',
              'font-size': '14px',
              'font-weight': '500',
              color:
                props.activeTab === tab.id
                  ? 'var(--clr-coral)'
                  : 'var(--clr-stone-gray)',
              'border-bottom':
                props.activeTab === tab.id
                  ? '2px solid var(--clr-terracotta)'
                  : '2px solid transparent',
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
