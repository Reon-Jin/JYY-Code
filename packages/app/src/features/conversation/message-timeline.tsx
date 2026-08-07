import { tr } from "../../i18n/i18n-context"
import type { Goal } from "@jyycode-ai/sdk/v2/client"
import { ArrowDown, Check, MessageCircle } from "lucide-solid"
import { createEffect, createMemo, createSignal, For, on, onCleanup, Show } from "solid-js"
import { Button } from "../../components/ui/button"
import { InlineError } from "../../components/ui/inline-error"
import { Spinner } from "../../components/ui/spinner"
import { ThinkingOrb } from "../../components/ui/thinking-orb"
import type { CompactionStatus } from "../../data/event-bridge"
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
  goal?: Goal
  compaction?: CompactionStatus
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

function GoalTimelineMarker(props: { marker: "start" | "end"; showOrb?: boolean }) {
  return (
    <div class="goal-timeline-marker" data-marker={props.marker}>
      <span class="goal-timeline-marker__line" />
      <Show when={props.marker === "start" && props.showOrb}>
        <ThinkingOrb class="thinking-orb" state="working" size={20} aria-label={tr("goal-mode.working")} />
      </Show>
      <span class="goal-timeline-marker__label">
        {props.marker === "start" ? tr("goal-mode.started") : tr("goal-mode.ended")}
      </span>
      <span class="goal-timeline-marker__line" />
    </div>
  )
}

function CompactionIndicator(props: { status?: CompactionStatus }) {
  const [visible, setVisible] = createSignal(true)
  createEffect(() => {
    if (props.status?.status !== "done") {
      setVisible(true)
      return
    }
    const timer = window.setTimeout(() => setVisible(false), 3000)
    onCleanup(() => window.clearTimeout(timer))
  })
  const status = createMemo(() => (visible() ? props.status : undefined))
  return (
    <Show when={status()}>
      {(current) => (
        <div class="compaction-indicator" data-status={current().status} role="status">
          <Show when={current().status === "compacting"} fallback={<Check aria-hidden="true" />}>
            <ThinkingOrb state="compacting" size={20} theme="light" aria-label={tr("conversation.compacting")} />
          </Show>
          <span>
            {current().status === "compacting"
              ? tr("conversation.compacting")
              : tr("conversation.compaction-complete")}
          </span>
        </div>
      )}
    </Show>
  )
}

function groupKey(group: PresentedMessageGroup) {
  return `${group.type}:${group.parts[0]?.id ?? "empty"}`
}

function PresentedGroupView(props: {
  group: PresentedMessageGroup
  messageRole: string
  messageAgent?: string
  pendingActivityKeys: ReadonlySet<string>
}) {
  const partIDs = createMemo(() => props.group.parts.map((part) => part.id))
  const partsByID = createMemo(() => new Map(props.group.parts.map((part) => [part.id, part])))
  const pending = () => props.group.type === "activity" && props.pendingActivityKeys.has(groupKey(props.group))

  const parts = () => (
    <For each={partIDs()}>
      {(partID) => (
        <MessagePartView
          part={partsByID().get(partID)!}
          messageRole={props.messageRole}
          messageAgent={props.messageAgent}
        />
      )}
    </For>
  )

  return (
    <Show when={props.group.type === "activity"} fallback={parts()}>
      <ActivityGroup
        label={tr("conversation.thinking-and-tool-calling")}
        count={props.group.parts.length}
        pending={pending()}
      >
        {parts()}
      </ActivityGroup>
    </Show>
  )
}

function PresentedMessageView(props: {
  message: PresentedConversationMessage
  pendingActivityKeys: ReadonlySet<string>
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
              pendingActivityKeys={props.pendingActivityKeys}
            />
          )}
        </For>
      </div>
    </article>
  )
}

export function MessageTimeline(props: MessageTimelineProps) {
  const [hasNewMessages, setHasNewMessages] = createSignal(false)
  const goalStatus = createMemo(() => props.goal?.status)
  const goalStartedAt = createMemo(() => props.goal?.startedAt)
  const goalCompletedAt = createMemo(() => props.goal?.completedAt)
  const signature = createMemo(
    () =>
      `${messageSignature(props.messages)}|goal:${goalStatus() ?? ""}:${goalStartedAt() ?? ""}:${
        goalCompletedAt() ?? ""
      }`,
  )
  const presentedMessages = createMemo(() => presentConversationMessages(props.messages))
  const goalEndIndex = createMemo(() => {
    const completedAt = goalCompletedAt()
    if (completedAt === undefined) return undefined
    const index = presentedMessages().findIndex((message) => message.info.time.created > completedAt)
    return index === -1 ? undefined : index
  })
  const messageIDs = createMemo(() => presentedMessages().map((message) => message.info.id))
  const messagesByID = createMemo(() => new Map(presentedMessages().map((message) => [message.info.id, message])))
  const pendingActivityKeys = createMemo(() => {
    const groups = presentedMessages().flatMap((message) => message.groups)
    const keys = new Set<string>()
    for (let i = 0; i < groups.length; i++) {
      const group = groups[i]!
      if (group.type !== "activity") continue
      const hasFormalContentAfter = groups.slice(i + 1).some((next) => next.type === "content")
      if (!hasFormalContentAfter) keys.add(groupKey(group))
    }
    return keys
  })
  let viewport: HTMLDivElement | undefined
  let pinnedToBottom = true
  let initialized = false
  let scrollFrame: number | undefined
  let touchStartY = 0

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
            onWheel={(event) => {
              if (event.deltaY < 0) {
                initialized = true
                pinnedToBottom = false
              }
            }}
            onTouchStart={(event) => {
              touchStartY = event.touches[0]?.clientY ?? 0
            }}
            onTouchMove={(event) => {
              const y = event.touches[0]?.clientY ?? touchStartY
              if (y > touchStartY) {
                initialized = true
                pinnedToBottom = false
              }
              touchStartY = y
            }}
            onScroll={() => {
              initialized = true
              pinnedToBottom = distanceFromBottom() <= 4
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
                <CompactionIndicator status={props.compaction} />
                <Show when={goalStartedAt() !== undefined}>
                  <GoalTimelineMarker marker="start" showOrb={goalStatus() === "running"} />
                </Show>
                <For each={messageIDs()}>
                  {(messageID, index) => (
                    <>
                      <Show when={goalEndIndex() !== undefined && index() === goalEndIndex()}>
                        <GoalTimelineMarker marker="end" />
                      </Show>
                      <PresentedMessageView
                        message={messagesByID().get(messageID)!}
                        pendingActivityKeys={pendingActivityKeys()}
                      />
                    </>
                  )}
                </For>
                <Show when={goalCompletedAt() !== undefined && goalEndIndex() === undefined}>
                  <GoalTimelineMarker marker="end" />
                </Show>
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
