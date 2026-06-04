import { For, Show } from 'solid-js'
import { Card } from '../ui/Card'
import { Badge } from '../ui/Badge'
import type { SessionInfo } from '../../types/models'

interface Props {
  sessions: SessionInfo[]
  onSelect: (session: SessionInfo) => void
  onCreateNew: () => void
}

function formatTime(ts: number): string {
  const diff = Date.now() - ts
  const minutes = Math.floor(diff / 60000)
  const hours = Math.floor(diff / 3600000)
  const days = Math.floor(diff / 86400000)
  if (minutes < 1) return '刚刚'
  if (minutes < 60) return `${minutes}分钟前`
  if (hours < 24) return `${hours}小时前`
  return `${days}天前`
}

const statusColors: Record<string, 'success' | 'info' | 'warning'> = {
  idle: 'success',
  running: 'info',
  error: 'warning',
}

export function SessionList(props: Props) {
  return (
    <Show when={props.sessions.length > 0} fallback={
      <div style={{
        'text-align': 'center',
        padding: '48px 0',
        color: 'var(--color-text-tertiary)',
      }}>
        <p class="text-body">暂无会话</p>
        <p class="text-caption" style={{ 'margin-top': '8px' }}>
          点击"新建会话"开始与 JYYCode 对话
        </p>
      </div>
    }>
      <div style={{
        display: 'flex',
        'flex-direction': 'column',
        gap: 'var(--space-8)',
      }}>
        <For each={props.sessions}>
          {(session) => (
            <Card hoverable padding="md" onClick={() => props.onSelect(session)}>
              <div style={{
                display: 'flex',
                'align-items': 'center',
                'justify-content': 'space-between',
              }}>
                <div style={{ flex: '1', 'min-width': '0' }}>
                  <h4 class="text-body-emphasis" style={{
                    'margin-bottom': '4px',
                    overflow: 'hidden',
                    'text-overflow': 'ellipsis',
                    'white-space': 'nowrap',
                  }}>
                    {session.title}
                  </h4>
                  <div style={{
                    display: 'flex',
                    gap: 'var(--space-10)',
                    'align-items': 'center',
                  }}>
                    <span class="text-caption" style={{ color: 'var(--color-text-tertiary)' }}>
                      {session.model}
                    </span>
                    <span class="text-caption" style={{ color: 'var(--color-text-tertiary)' }}>
                      {session.messageCount} 条消息
                    </span>
                  </div>
                </div>
                <div style={{
                  display: 'flex',
                  'align-items': 'center',
                  gap: 'var(--space-8)',
                  'flex-shrink': '0',
                }}>
                  <Badge variant={statusColors[session.status] as any} dot>
                    {session.status === 'running' ? '进行中' : session.status === 'error' ? '错误' : '空闲'}
                  </Badge>
                  <span class="text-caption" style={{ color: 'var(--color-text-tertiary)' }}>
                    {formatTime(session.updatedAt)}
                  </span>
                </div>
              </div>
            </Card>
          )}
        </For>
      </div>
    </Show>
  )
}
