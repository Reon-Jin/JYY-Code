import { createSignal } from 'solid-js'
import { Button } from '../ui/Button'
import type { Email } from '../../types/models'

interface Props {
  email: Email
  onReply: (text: string) => void
}

export function EmailDetail(props: Props) {
  const { email } = props
  const [replyText, setReplyText] = createSignal('')

  function handleSend() {
    const text = replyText().trim()
    if (!text) return
    props.onReply(text)
    setReplyText('')
  }

  return (
    <div style={{
      flex: '1',
      display: 'flex',
      'flex-direction': 'column',
      overflow: 'hidden',
    }}>
      {/* Email header */}
      <div style={{
        padding: 'var(--space-14) var(--space-20)',
        'border-bottom': '1px solid rgba(0,0,0,0.06)',
      }}>
        <div style={{
          display: 'flex',
          'justify-content': 'space-between',
          'align-items': 'flex-start',
          'margin-bottom': '12px',
        }}>
          <div>
            <p class="text-caption-bold">{email.from}</p>
            <p class="text-micro" style={{ color: 'var(--color-text-tertiary)' }}>
              发送至 {email.to}
            </p>
          </div>
          <span class="text-micro" style={{ color: 'var(--color-text-tertiary)' }}>
            {new Date(email.timestamp).toLocaleString()}
          </span>
        </div>
        <h3 class="text-card-title">{email.subject}</h3>
      </div>

      {/* Email body */}
      <div style={{
        flex: '1',
        overflow: 'auto',
        padding: 'var(--space-14) var(--space-20)',
      }}>
        <p class="text-body" style={{
          'white-space': 'pre-wrap',
          'word-break': 'break-word',
        }}>
          {email.body}
        </p>
      </div>

      {/* Reply area */}
      <div style={{
        'border-top': '1px solid rgba(0,0,0,0.06)',
        padding: 'var(--space-10) var(--space-20) var(--space-14)',
      }}>
        <div style={{ 'margin-bottom': 'var(--space-8)' }}>
          <p class="text-caption-bold" style={{ 'margin-bottom': '4px' }}>
            回复
          </p>
        </div>
        <div style={{
          display: 'flex',
          gap: 'var(--space-10)',
          'align-items': 'flex-end',
        }}>
          <textarea
            value={replyText()}
            onInput={(e) => setReplyText(e.currentTarget.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault()
                handleSend()
              }
            }}
            placeholder="输入回复内容..."
            rows={2}
            style={{
              flex: '1',
              background: 'var(--color-filter-bg)',
              border: '3px solid rgba(0,0,0,0.04)',
              'border-radius': 'var(--radius-search)',
              padding: 'var(--space-8) var(--space-10)',
              'font-family': 'var(--font-text)',
              'font-size': '15px',
              'line-height': '1.47',
              'letter-spacing': '-0.374px',
              color: 'var(--color-text-primary)',
              resize: 'none',
              outline: 'none',
            }}
            onFocus={(e) => {
              e.currentTarget.style.borderColor = 'var(--color-blue-apple)'
            }}
            onBlur={(e) => {
              e.currentTarget.style.borderColor = 'rgba(0,0,0,0.04)'
            }}
          />
          <Button variant="primary" size="md" onClick={handleSend}>
            发送
          </Button>
        </div>
      </div>
    </div>
  )
}
