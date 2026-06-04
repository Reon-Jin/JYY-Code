import { Card } from '../ui/Card'
import { Badge } from '../ui/Badge'

interface Props {
  unreadCount: number
  onOpen: () => void
}

export function EmailPanel(props: Props) {
  return (
    <Card hoverable padding="lg" onClick={props.onOpen}>
      <div style={{
        display: 'flex',
        'align-items': 'center',
        'justify-content': 'space-between',
      }}>
        <div style={{
          display: 'flex',
          'align-items': 'center',
          gap: 'var(--space-14)',
        }}>
          <span style={{ 'font-size': '28px' }}>📬</span>
          <div>
            <h3 class="text-card-title" style={{ 'margin-bottom': '4px' }}>
              邮件
            </h3>
            <p class="text-caption" style={{ color: 'var(--color-text-secondary)' }}>
              {props.unreadCount > 0
                ? `${props.unreadCount} 封未读邮件 · 来自用户`
                : '无未读邮件'}
            </p>
          </div>
        </div>
        <div style={{
          display: 'flex',
          'align-items': 'center',
          gap: 'var(--space-8)',
        }}>
          {props.unreadCount > 0 && <Badge count={props.unreadCount} />}
          <span class="text-link" style={{ cursor: 'pointer' }}>查看 →</span>
        </div>
      </div>
    </Card>
  )
}
