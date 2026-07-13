import { ArrowDown, MessageCircle } from "lucide-solid"
import { createEffect, createMemo, createSignal, For, on, Show } from "solid-js"
import { Button } from "../../components/ui/button"
import { InlineError } from "../../components/ui/inline-error"
import { Spinner } from "../../components/ui/spinner"
import type { ConversationMessage } from "./conversation-state"
import { MessagePartView } from "./message-part"
import "./conversation.css"

export type MessageTimelineProps = {
  messages: readonly ConversationMessage[]
  loading?: boolean
  error?: string
  onRetry?: () => void
}

function messageSignature(messages: readonly ConversationMessage[]) {
  return messages
    .map(
      (message) =>
        `${message.info.id}:${message.parts
          .map((part) => {
            if (part.type === "text" || part.type === "reasoning") return `${part.id}:${part.text.length}`
            if (part.type === "tool") return `${part.id}:${part.state.status}`
            return part.id
          })
          .join(",")}`,
    )
    .join("|")
}

export function MessageTimeline(props: MessageTimelineProps) {
  const [hasNewMessages, setHasNewMessages] = createSignal(false)
  const signature = createMemo(() => messageSignature(props.messages))
  let viewport: HTMLDivElement | undefined
  let pinnedToBottom = true
  let initialized = false

  function distanceFromBottom() {
    if (!viewport) return 0
    return viewport.scrollHeight - viewport.scrollTop - viewport.clientHeight
  }

  function scrollToBottom() {
    if (!viewport) return
    viewport.scrollTop = viewport.scrollHeight
    pinnedToBottom = true
    setHasNewMessages(false)
  }

  createEffect(
    on(signature, () => {
      queueMicrotask(() => {
        if (!viewport) return
        if (!initialized || pinnedToBottom) scrollToBottom()
        else setHasNewMessages(true)
        initialized = true
      })
    }),
  )

  return (
    <section class="message-timeline" aria-label="对话消息">
      <Show
        when={!props.loading}
        fallback={
          <div class="message-timeline__loading" role="status">
            <Spinner /> 正在加载消息
          </div>
        }
      >
        <Show
          when={!props.error}
          fallback={
            <div class="message-timeline__error">
              <InlineError message={props.error!} />
              <Show when={props.onRetry}>
                <Button size="small" variant="secondary" onClick={props.onRetry}>
                  重新加载
                </Button>
              </Show>
            </div>
          }
        >
          <div
            ref={viewport}
            class="message-timeline__viewport"
            onScroll={() => {
              pinnedToBottom = distanceFromBottom() <= 80
              if (pinnedToBottom) setHasNewMessages(false)
            }}
          >
            <Show
              when={props.messages.length > 0}
              fallback={
                <div class="message-timeline__empty" role="status">
                  <MessageCircle aria-hidden="true" />
                  <span>还没有消息，从下方开始对话。</span>
                </div>
              }
            >
              <div class="message-timeline__content">
                <For each={props.messages}>
                  {(message, index) => (
                    <article
                      class="conversation-message"
                      data-role={message.info.role}
                      aria-label={message.info.role === "user" ? "我的消息" : "Agent 回复"}
                    >
                      <Show
                        when={
                          message.info.role === "assistant" &&
                          (index() === 0 ||
                            props.messages[index() - 1]?.info.role !== "assistant" ||
                            props.messages[index() - 1]?.info.agent !== message.info.agent)
                        }
                      >
                        <header>{message.info.agent}</header>
                      </Show>
                      <div class="conversation-message__parts">
                        <For each={message.parts}>{(part) => <MessagePartView part={part} />}</For>
                      </div>
                    </article>
                  )}
                </For>
              </div>
            </Show>
          </div>
        </Show>
      </Show>

      <Show when={hasNewMessages()}>
        <Button class="message-timeline__new" variant="secondary" size="small" onClick={scrollToBottom}>
          <ArrowDown aria-hidden="true" /> 新消息
        </Button>
      </Show>
    </section>
  )
}
