import { For, createEffect, onCleanup } from 'solid-js'
import type { Message } from '../../types/models'
import { UserMessage } from './UserMessage'
import { AssistantMessage } from './AssistantMessage'

interface Props {
  messages: Message[]
  streamingMessageId?: string | null
  onApprovePermission: (messageId: string) => void
  onDenyPermission: (messageId: string) => void
}

export function MessageList(props: Props) {
  let containerRef!: HTMLDivElement
  let shouldAutoScroll = true

  // Auto-scroll to bottom on new messages (unless user scrolled up)
  function handleScroll() {
    if (!containerRef) return
    const { scrollTop, scrollHeight, clientHeight } = containerRef
    shouldAutoScroll = scrollHeight - scrollTop - clientHeight < 100
  }

  createEffect(() => {
    // Trigger re-scroll when messages change
    props.messages.length
    if (shouldAutoScroll && containerRef) {
      setTimeout(() => {
        containerRef.scrollTop = containerRef.scrollHeight
      }, 50)
    }
  })

  return (
    <div
      ref={containerRef}
      onScroll={handleScroll}
      style={{
        flex: '1',
        overflow: 'auto',
        padding: 'var(--space-14) var(--space-20)',
      }}
    >
      <div style={{
        'max-width': '760px',
        margin: '0 auto',
        display: 'flex',
        'flex-direction': 'column',
        gap: 'var(--space-14)',
      }}>
        <For each={props.messages}>
          {(message) => (
            <>
              {message.role === 'user' && <UserMessage message={message} />}
              {message.role === 'assistant' && (
                <AssistantMessage
                  message={message}
                  isStreaming={message.id === props.streamingMessageId}
                  onApprovePermission={() => props.onApprovePermission(message.id)}
                  onDenyPermission={() => props.onDenyPermission(message.id)}
                />
              )}
            </>
          )}
        </For>

        {/* Empty state */}
        {props.messages.length === 0 && (
          <div style={{
            'text-align': 'center',
            padding: '64px 0',
            color: 'var(--color-text-tertiary)',
          }}>
            <p style={{ 'font-size': '32px', 'margin-bottom': '16px' }}>💬</p>
            <p class="text-body">开始与 JYYCode 对话</p>
            <p class="text-caption" style={{ 'margin-top': '8px' }}>
              在下方输入您的问题，AI 将为您提供帮助
            </p>
          </div>
        )}
      </div>
    </div>
  )
}
