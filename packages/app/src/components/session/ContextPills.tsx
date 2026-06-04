import { For } from 'solid-js'

interface Props {
  files: string[]
  onRemove: (file: string) => void
  onClear: () => void
}

export function ContextPills(props: Props) {
  return (
    <div style={{
      display: 'flex',
      'align-items': 'center',
      gap: 'var(--space-6)',
      'flex-wrap': 'wrap',
    }}>
      <For each={props.files}>
        {(file) => (
          <div style={{
            display: 'inline-flex',
            'align-items': 'center',
            gap: 'var(--space-4)',
            padding: '2px 6px 2px 10px',
            'border-radius': '980px',
            background: 'rgba(0,113,227,0.08)',
            color: 'var(--color-blue-apple)',
            'font-size': '12px',
            'font-weight': '500',
            'letter-spacing': '-0.12px',
            'max-width': '200px',
          }}>
            <span style={{ 'font-size': '12px' }}>📄</span>
            <span style={{
              overflow: 'hidden',
              'text-overflow': 'ellipsis',
              'white-space': 'nowrap',
            }}>
              {file.split(/[/\\]/).pop() || file}
            </span>
            <button
              onClick={() => props.onRemove(file)}
              style={{
                background: 'none',
                border: 'none',
                color: 'inherit',
                cursor: 'pointer',
                padding: '0 2px',
                'font-size': '14px',
                'line-height': '1',
                opacity: '0.7',
                display: 'flex',
                'align-items': 'center',
              }}
              title="移除"
            >
              ×
            </button>
          </div>
        )}
      </For>

      {props.files.length > 1 && (
        <button
          onClick={props.onClear}
          style={{
            background: 'none',
            border: 'none',
            color: 'var(--color-text-tertiary)',
            cursor: 'pointer',
            'font-size': '12px',
            padding: '2px 8px',
            'border-radius': '8px',
            transition: 'background 0.15s',
          }}
        >
          清除全部
        </button>
      )}
    </div>
  )
}
