import type { PermissionRequestPart } from '../../../types/models'
import { Button } from '../../ui/Button'

interface Props {
  part: PermissionRequestPart
  onApprove: () => void
  onDeny: () => void
}

export function PermissionBlock(props: Props) {
  const { part } = props

  return (
    <div style={{
      margin: 'var(--space-10) 0',
      padding: 'var(--space-14)',
      'border-radius': 'var(--radius-feature)',
      border: '1px solid rgba(0,113,227,0.3)',
      background: 'rgba(0,113,227,0.04)',
    }}>
      <div style={{
        display: 'flex',
        'align-items': 'flex-start',
        gap: 'var(--space-10)',
        'margin-bottom': 'var(--space-10)',
      }}>
        <span style={{ 'font-size': '20px' }}>🔒</span>
        <div>
          <p class="text-caption-bold" style={{ 'margin-bottom': '4px' }}>
            {part.toolName} — 需要权限
          </p>
          <p class="text-caption" style={{ color: 'var(--color-text-secondary)' }}>
            {part.message}
          </p>
        </div>
      </div>

      <div style={{
        display: 'flex',
        gap: 'var(--space-8)',
        'justify-content': 'flex-end',
      }}>
        <Button variant="outline" size="sm" onClick={props.onDeny}>
          拒绝
        </Button>
        <Button variant="primary" size="sm" onClick={props.onApprove}>
          允许
        </Button>
      </div>
    </div>
  )
}
