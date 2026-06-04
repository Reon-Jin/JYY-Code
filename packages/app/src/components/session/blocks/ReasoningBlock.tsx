import { createSignal } from 'solid-js'
import type { ReasoningPart } from '../../../types/models'

interface Props {
  part: ReasoningPart
}

export function ReasoningBlock(props: Props) {
  const [collapsed, setCollapsed] = createSignal(props.part.collapsed ?? false)

  return (
    <div style={{
      'margin': 'var(--space-8) 0',
      'border-radius': 'var(--radius-standard)',
      'border': '1px solid rgba(0,0,0,0.06)',
      overflow: 'hidden',
    }}>
      {/* Header */}
      <button
        onClick={() => setCollapsed(!collapsed())}
        style={{
          width: '100%',
          display: 'flex',
          'align-items': 'center',
          gap: 'var(--space-8)',
          padding: 'var(--space-8) var(--space-10)',
          border: 'none',
          background: 'var(--color-filter-bg)',
          cursor: 'pointer',
          'font-family': 'var(--font-text)',
          'font-size': '14px',
          color: 'var(--color-text-secondary)',
          transition: 'background 0.15s',
        }}
      >
        <span>💭</span>
        <span class="text-caption" style={{ flex: '1', 'text-align': 'left' }}>
          思考过程
        </span>
        <span style={{
          transition: 'transform 0.2s',
          transform: collapsed() ? 'rotate(-90deg)' : 'rotate(0deg)',
          'font-size': '10px',
        }}>
          ▼
        </span>
      </button>

      {/* Content */}
      {!collapsed() && (
        <div style={{
          padding: 'var(--space-10) var(--space-14)',
          background: 'rgba(0,0,0,0.02)',
          'font-family': 'var(--font-text)',
          'font-size': '14px',
          color: 'var(--color-text-secondary)',
          'line-height': '1.5',
          'white-space': 'pre-wrap',
          'word-break': 'break-word',
          'max-height': '300px',
          'overflow-y': 'auto',
        }}>
          {props.part.content}
        </div>
      )}
    </div>
  )
}
