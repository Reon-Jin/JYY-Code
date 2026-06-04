import type { Email } from '../../types/models'

interface Props {
  email: Email
  selected: boolean
  onClick: () => void
}

export function EmailItem(props: Props) {
  const { email } = props

  return (
    <div
      onClick={props.onClick}
      style={{
        padding: 'var(--space-10) var(--space-14)',
        cursor: 'pointer',
        background: props.selected ? 'rgba(0,113,227,0.06)' : 'transparent',
        'border-left': props.selected ? '3px solid var(--color-blue-apple)' : '3px solid transparent',
        'border-bottom': '1px solid rgba(0,0,0,0.04)',
        transition: 'background 0.15s',
      }}
      onMouseEnter={(e) => {
        if (!props.selected) e.currentTarget.style.background = 'rgba(0,0,0,0.02)'
      }}
      onMouseLeave={(e) => {
        if (!props.selected) e.currentTarget.style.background = 'transparent'
      }}
    >
      {/* From + time */}
      <div style={{
        display: 'flex',
        'justify-content': 'space-between',
        'align-items': 'center',
        'margin-bottom': '4px',
      }}>
        <span class="text-caption-bold" style={{
          color: email.read ? 'var(--color-text-secondary)' : 'var(--color-text-primary)',
        }}>
          {email.from}
        </span>
        <span class="text-micro" style={{ color: 'var(--color-text-tertiary)' }}>
          {formatShortTime(email.timestamp)}
        </span>
      </div>

      {/* Subject */}
      <p class="text-caption" style={{
        color: email.read ? 'var(--color-text-tertiary)' : 'var(--color-text-primary)',
        'font-weight': email.read ? '400' : '600',
        overflow: 'hidden',
        'text-overflow': 'ellipsis',
        'white-space': 'nowrap',
        'margin-bottom': '2px',
      }}>
        {!email.read && <span style={{
          display: 'inline-block',
          width: '8px', height: '8px',
          'border-radius': '50%',
          background: 'var(--color-blue-apple)',
          'margin-right': '6px',
        }} />}
        {email.subject}
      </p>

      {/* Preview */}
      <p class="text-micro" style={{
        color: 'var(--color-text-tertiary)',
        overflow: 'hidden',
        'text-overflow': 'ellipsis',
        'white-space': 'nowrap',
      }}>
        {email.body.slice(0, 80)}
      </p>
    </div>
  )
}

function formatShortTime(ts: number): string {
  const date = new Date(ts)
  const now = new Date()
  const isToday = date.toDateString() === now.toDateString()
  if (isToday) {
    return `${date.getHours()}:${String(date.getMinutes()).padStart(2, '0')}`
  }
  return `${date.getMonth() + 1}/${date.getDate()}`
}
