import { createSignal, Show, For } from 'solid-js'
import type { FileChange, DiffLine } from '../../types/models'

interface Props {
  change: FileChange
  defaultExpanded?: boolean
}

export function FileDiff(props: Props) {
  const [expanded, setExpanded] = createSignal(props.defaultExpanded ?? false)

  const statusIcon = () => {
    switch (props.change.status) {
      case 'added': return '+'
      case 'deleted': return '−'
      case 'modified': return '~'
    }
  }

  return (
    <div style={{
      'margin-bottom': 'var(--space-4)',
      'border-radius': 'var(--radius-standard)',
      overflow: 'hidden',
      border: '1px solid rgba(0,0,0,0.06)',
    }}>
      {/* File header */}
      <div
        onClick={() => setExpanded(!expanded())}
        style={{
          display: 'flex',
          'align-items': 'center',
          'justify-content': 'space-between',
          padding: 'var(--space-8) var(--space-10)',
          background: 'var(--color-filter-bg)',
          cursor: 'pointer',
          'user-select': 'none',
        }}
      >
        <div style={{
          display: 'flex',
          'align-items': 'center',
          gap: 'var(--space-8)',
          'min-width': '0',
        }}>
          <span style={{
            color: props.change.status === 'added' ? '#2cbe4e' :
                   props.change.status === 'deleted' ? '#cb2431' :
                   'var(--color-text-secondary)',
            'font-size': '12px',
          }}>
            {statusIcon()}
          </span>
          <span class="text-caption" style={{
            overflow: 'hidden',
            'text-overflow': 'ellipsis',
            'white-space': 'nowrap',
          }}>
            {props.change.filePath}
          </span>
        </div>
        <div style={{
          display: 'flex',
          gap: 'var(--space-8)',
          'flex-shrink': '0',
        }}>
          {props.change.additions > 0 && (
            <span style={{
              'font-size': '12px',
              'font-weight': '600',
              color: '#2cbe4e',
            }}>+{props.change.additions}</span>
          )}
          {props.change.deletions > 0 && (
            <span style={{
              'font-size': '12px',
              'font-weight': '600',
              color: '#cb2431',
            }}>-{props.change.deletions}</span>
          )}
          <span style={{
            'font-size': '12px',
            color: 'var(--color-text-tertiary)',
            transition: 'transform 0.2s',
            transform: expanded() ? 'rotate(90deg)' : 'rotate(0deg)',
          }}>▶</span>
        </div>
      </div>

      {/* Diff content */}
      <Show when={expanded()}>
        <div style={{
          'font-family': 'var(--font-mono)',
          'font-size': '13px',
          'line-height': '1.5',
          'overflow-x': 'auto',
        }}>
          <For each={props.change.hunks}>
            {(hunk) => (
              <div>
                {/* Hunk header */}
                <div style={{
                  padding: '2px 10px',
                  background: 'rgba(0,0,0,0.03)',
                  color: 'var(--color-text-tertiary)',
                  'font-size': '12px',
                }}>
                  {hunk.header}
                </div>
                {/* Lines */}
                <For each={hunk.lines}>
                  {(line) => <DiffLineRow line={line} />}
                </For>
              </div>
            )}
          </For>
        </div>
      </Show>
    </div>
  )
}

function DiffLineRow(props: { line: DiffLine }) {
  const { line } = props

  const bgColor = () => {
    switch (line.type) {
      case 'addition': return 'var(--diff-addition-bg)'
      case 'deletion': return 'var(--diff-deletion-bg)'
      default: return 'transparent'
    }
  }

  const borderColor = () => {
    switch (line.type) {
      case 'addition': return 'var(--diff-addition-border)'
      case 'deletion': return 'var(--diff-deletion-border)'
      default: return 'transparent'
    }
  }

  const signColor = () => {
    switch (line.type) {
      case 'addition': return 'var(--diff-addition-border)'
      case 'deletion': return 'var(--diff-deletion-border)'
      default: return 'var(--color-text-tertiary)'
    }
  }

  const sign = () => {
    switch (line.type) {
      case 'addition': return '+'
      case 'deletion': return '−'
      default: return ' '
    }
  }

  return (
    <div style={{
      display: 'flex',
      background: bgColor(),
      'border-left': `3px solid ${borderColor()}`,
      'padding-left': '7px',
    }}>
      {/* Line numbers */}
      <span style={{
        display: 'inline-block',
        width: '40px',
        'text-align': 'right',
        padding: '0 8px',
        color: 'var(--color-text-tertiary)',
        'font-size': '12px',
        'user-select': 'none',
        'flex-shrink': '0',
      }}>
        {line.oldLineNumber ?? ''}
      </span>
      <span style={{
        display: 'inline-block',
        width: '40px',
        'text-align': 'right',
        padding: '0 8px',
        color: 'var(--color-text-tertiary)',
        'font-size': '12px',
        'user-select': 'none',
        'flex-shrink': '0',
      }}>
        {line.newLineNumber ?? ''}
      </span>
      {/* Sign */}
      <span style={{
        width: '16px',
        'text-align': 'center',
        color: signColor(),
        'font-weight': '600',
        'flex-shrink': '0',
      }}>
        {sign()}
      </span>
      {/* Content */}
      <span style={{
        padding: '0 8px',
        'white-space': 'pre',
        overflow: 'hidden',
        'text-overflow': 'ellipsis',
        color: 'var(--color-text-primary)',
      }}>
        {line.content}
      </span>
    </div>
  )
}
