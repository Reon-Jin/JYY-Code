import { For, Show, createEffect } from 'solid-js'
import type { Message } from '../../types/models'
import { UserMessage } from './UserMessage'
import { AssistantMessage } from './AssistantMessage'

interface Props {
  messages: Message[]
  streamingMessageId?: string | null
  onApprovePermission: (permissionId: string) => void
  onDenyPermission: (permissionId: string) => void
}

export function MessageList(props: Props) {
  let containerRef!: HTMLDivElement
  let shouldAutoScroll = true

  function handleScroll() {
    if (!containerRef) return
    const { scrollTop, scrollHeight, clientHeight } = containerRef
    shouldAutoScroll = scrollHeight - scrollTop - clientHeight < 120
  }

  createEffect(() => {
    props.messages.length
    props.streamingMessageId
    if (shouldAutoScroll && containerRef) {
      requestAnimationFrame(() => {
        containerRef.scrollTop = containerRef.scrollHeight
      })
    }
  })

  return (
    <main ref={containerRef} onScroll={handleScroll} class="message-scroll">
      <div class="message-stack">
        <Show when={props.messages.length === 0}>
          <div class="empty-session">
            <div class="brand-mark">J</div>
            <h1>Let's build something useful</h1>
            <p>Pick a project, choose a DeepSeek model, attach files, then start a task.</p>
          </div>
        </Show>

        <For each={props.messages}>
          {(message) => (
            <>
              {message.role === 'user' && <UserMessage message={message} />}
              {message.role === 'assistant' && (
                <AssistantMessage
                  message={message}
                  isStreaming={message.id === props.streamingMessageId}
                  onApprovePermission={props.onApprovePermission}
                  onDenyPermission={props.onDenyPermission}
                />
              )}
            </>
          )}
        </For>
      </div>
    </main>
  )
}
