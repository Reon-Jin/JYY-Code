import { tr } from "../../i18n/i18n-context"
import { ArrowDown, MessageCircle } from "lucide-solid"
import { createEffect, createMemo, createSignal, For, on, onCleanup, Show } from "solid-js"
import { Button } from "../../components/ui/button"
import { InlineError } from "../../components/ui/inline-error"
import { Spinner } from "../../components/ui/spinner"
import type { ConversationMessage } from "./conversation-state"
import { ActivityGroup } from "./activity-group"
import { MessagePartView } from "./message-part"
import {
  presentConversationMessages,
  type PresentedConversationMessage,
  type PresentedMessageGroup,
} from "./message-presentation"
import "./conversation.css"

export type MessageTimelineProps = {
  messages: readonly ConversationMessage[]
  loading?: boolean
  error?: string
  planStatus?: "planning" | "ready"
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

function groupKey(group: PresentedMessageGroup) {
  return `${group.type}:${group.parts[0]?.id ?? "empty"}`
}

function PresentedGroupView(props: {
  group: PresentedMessageGroup
  messageRole: string
  messageAgent?: string
  planStatus?: "planning" | "ready"
}) {
  const partIDs = createMemo(() => props.group.parts.map((part) => part.id))
  const partsByID = createMemo(() => new Map(props.group.parts.map((part) => [part.id, part])))
  const running = () =>
    props.group.parts.some(
      (part) => part.type === "tool" && (part.state.status === "pending" || part.state.status === "running"),
    )

  const parts = () => (
    <For each={partIDs()}>
      {(partID) => (
        <MessagePartView
          part={partsByID().get(partID)!}
          messageRole={props.messageRole}
          messageAgent={props.messageAgent}
          planStatus={props.planStatus}
        />
      )}
    </For>
  )

  return (
    <Show when={props.group.type === "activity"} fallback={parts()}>
      <ActivityGroup label={tr("conversation.thinking-and-tool-calling")} count={props.group.parts.length} running={running()}>
        {parts()}
      </ActivityGroup>
    </Show>
  )
}

function PresentedMessageView(props: {
  message: PresentedConversationMessage
  planStatus?: "planning" | "ready"
}) {
  const groupKeys = createMemo(() => props.message.groups.map(groupKey))
  const groupsByKey = createMemo(() => new Map(props.message.groups.map((group) => [groupKey(group), group])))
  const agent = () =>
    props.message.info.role === "assistant"
      ? (props.message.info.agent ?? props.message.info.mode)
      : props.message.info.agent

  return (
    <article
      class="conversation-message"
      data-role={props.message.info.role}
      aria-label={props.message.info.role === "user" ? tr("conversation.my-message") : tr("conversation.agent-reply")}
    >
      <Show when={props.message.info.role === "assistant"}>
        <header>{props.message.info.agent}</header>
      </Show>
      <div class="conversation-message__parts">
        <For each={groupKeys()}>
          {(key) => (
            <PresentedGroupView
              group={groupsByKey().get(key)!}
              messageRole={props.message.info.role}
              messageAgent={agent()}
              planStatus={props.planStatus}
            />
          )}
        </For>
      </div>
    </article>
  )
}

export function MessageTimeline(props: MessageTimelineProps) {
  const [hasNewMessages, setHasNewMessages] = createSignal(false)
  const signature = createMemo(() => messageSignature(props.messages))
  const presentedMessages = createMemo(() => presentConversationMessages(props.messages))
  const messageIDs = createMemo(() => presentedMessages().map((message) => message.info.id))
  const messagesByID = createMemo(() => new Map(presentedMessages().map((message) => [message.info.id, message])))
  let viewport: HTMLDivElement | undefined
  let pinnedToBottom = true
  let initialized = false
  let scrollFrame: number | undefined

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
      if (scrollFrame !== undefined) return
      scrollFrame = window.requestAnimationFrame(() => {
        scrollFrame = undefined
        if (!viewport) return
        if (!initialized || pinnedToBottom) scrollToBottom()
        else setHasNewMessages(true)
        initialized = true
      })
    }),
  )

  onCleanup(() => {
    if (scrollFrame !== undefined) window.cancelAnimationFrame(scrollFrame)
  })

  return (
    <section class="message-timeline" aria-label={tr("conversation.conversation-messages")}>
      <Show
        when={!props.loading}
        fallback={
          <div class="message-timeline__loading" role="status">
            <Spinner /> {tr("conversation.loading-messages")}
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
                  {tr("conversation.reload")}
                </Button>
              </Show>
            </div>
          }
        >
          <div
            ref={viewport}
            class="message-timeline__viewport"
            onScroll={() => {
              initialized = true
              pinnedToBottom = distanceFromBottom() <= 80
              if (pinnedToBottom) setHasNewMessages(false)
            }}
          >
            <Show
              when={presentedMessages().length > 0}
              fallback={
                <div class="message-timeline__empty" role="status">
                  <MessageCircle aria-hidden="true" />
                  <span>{tr("conversation.no-news-yet-start-the-conversation-below")}</span>
                </div>
              }
            >
              <div class="message-timeline__content">
                <For each={messageIDs()}>
                  {(messageID) => (
                    <PresentedMessageView message={messagesByID().get(messageID)!} planStatus={props.planStatus} />
                  )}
                </For>
              </div>
            </Show>
          </div>
        </Show>
      </Show>

      <Show when={hasNewMessages()}>
        <Button class="message-timeline__new" variant="secondary" size="small" onClick={scrollToBottom}>
          <ArrowDown aria-hidden="true" /> {tr("conversation.new-news")}
        </Button>
      </Show>
    </section>
  )
}
