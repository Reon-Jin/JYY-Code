import { tr } from "../../i18n/i18n-context"
import type { Session } from "@jyycode-ai/sdk/v2/client"
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
import { completeUIPerformanceStage } from "../../performance/ui-performance"

type Goal = NonNullable<Session["goal"]>

type GoalTimelineMarkerEvent = {
  marker: "start" | "end"
  messageIndex: number
  time: number
  showOrb: boolean
  key: string
}

export type MessageTimelineProps = {
  messages: readonly ConversationMessage[]
  goal?: Goal
  compaction?: CompactionStatus | null
  loading?: boolean
  error?: string
  onRetry?: () => void
}

const messageSignatures = new WeakMap<object, string>()

function messageSignatureFor(message: ConversationMessage) {
  const cached = messageSignatures.get(message)
  if (cached !== undefined) return cached
  const signature = `${message.info.id}:${message.parts
    .map((part) => {
      if (part.type === "text" || part.type === "reasoning") return `${part.id}:${part.text.length}`
      if (part.type === "tool") return `${part.id}:${part.state.status}`
      return part.id
    })
    .join(",")}`
  messageSignatures.set(message, signature)
  return signature
}

function createMessageSignatureTracker() {
  let previousMessages: readonly ConversationMessage[] | undefined
  let previousEntries: string[] = []
  let previousValue = ""

  return (messages: readonly ConversationMessage[]) => {
    if (messages === previousMessages) return previousValue

    let stableLength = 0
    if (previousMessages && previousMessages.length > 0) {
      const previousLength = previousMessages.length
      const lastPrevious = previousMessages[previousLength - 1]
      // Conversation snapshots append messages or replace the latest message
      // while it streams. Keep the unchanged prefix without rescanning it.
      if (messages.length >= previousLength && messages[previousLength - 1] === lastPrevious) {
        stableLength = previousLength
      } else if (
        messages.length === previousLength &&
        previousLength > 1 &&
        messages[previousLength - 2] === previousMessages[previousLength - 2]
      ) {
        stableLength = previousLength - 1
      } else {
        const commonLength = Math.min(messages.length, previousLength)
        while (stableLength < commonLength && messages[stableLength] === previousMessages[stableLength]) {
          stableLength += 1
        }
      }
    }

    const entries = previousEntries.slice(0, stableLength)
    for (let index = stableLength; index < messages.length; index += 1) {
      entries[index] = messageSignatureFor(messages[index]!)
    }
    previousMessages = messages
    previousEntries = entries
    previousValue = entries.join("|")
    return previousValue
  }
}

function goalRuns(goal?: Goal) {
  return goal ? [...(goal.history ?? []), goal] : []
}

function startMarkerMessageIndex(
  messages: readonly PresentedConversationMessage[],
  startedAt: number,
  nextStartedAt?: number,
) {
  const index = messages.findIndex((message) => {
    const created = message.info.time.created
    return created >= startedAt && (nextStartedAt === undefined || created < nextStartedAt)
  })
  return index === -1 ? undefined : index
}

function endMarkerMessageIndex(messages: readonly PresentedConversationMessage[], completedAt: number) {
  let index = -1
  for (let i = 0; i < messages.length; i += 1) {
    if (messages[i]!.info.time.created > completedAt) break
    index = i
  }
  return index
}

function goalTimelineMarkers(
  goal: Goal | undefined,
  messages: readonly PresentedConversationMessage[],
): GoalTimelineMarkerEvent[] {
  const runs = goalRuns(goal)
  const markers: GoalTimelineMarkerEvent[] = []

  for (const [runIndex, run] of runs.entries()) {
    const nextStartedAt = runs[runIndex + 1]?.startedAt
    const startedAt = run.startedAt
    const startMessageIndex =
      startedAt === undefined ? undefined : startMarkerMessageIndex(messages, startedAt, nextStartedAt)
    if (startedAt !== undefined && startMessageIndex !== undefined) {
      markers.push({
        marker: "start",
        messageIndex: startMessageIndex,
        time: startedAt,
        showOrb: runIndex === runs.length - 1 && run.status === "running",
        key: `goal:${runIndex}:start`,
      })
    }
    if (
      startMessageIndex !== undefined &&
      (run.status === "done" || run.status === "failed") &&
      run.completedAt !== undefined
    ) {
      markers.push({
        marker: "end",
        messageIndex: endMarkerMessageIndex(messages, run.completedAt),
        time: run.completedAt,
        showOrb: false,
        key: `goal:${runIndex}:end`,
      })
    }
  }

  return markers.sort((left, right) => {
    if (left.messageIndex !== right.messageIndex) return left.messageIndex - right.messageIndex
    if (left.time !== right.time) return left.time - right.time
    if (left.marker === right.marker) return 0
    return left.marker === "start" ? -1 : 1
  })
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

function CompactionIndicator(props: { status?: CompactionStatus | null }) {
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
            {current().status === "compacting" ? tr("conversation.compacting") : tr("conversation.compaction-complete")}
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
        <Show when={!props.message.pendingEmpty}>
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
        </Show>
        <Show when={props.message.pendingEmpty}>
          <ActivityGroup label={tr("conversation.thinking-and-tool-calling")} count={0} pending>
            <span class="conversation-message__waiting" role="status">
              {tr("conversation.waiting-for-execution")}
            </span>
          </ActivityGroup>
        </Show>
      </div>
    </article>
  )
}

export function MessageTimeline(props: MessageTimelineProps) {
  const [hasNewMessages, setHasNewMessages] = createSignal(false)
  let conversationPainted = false
  const signatureFor = createMessageSignatureTracker()
  const presentedMessages = createMemo(() => presentConversationMessages(props.messages))
  const goalMarkers = createMemo(() => goalTimelineMarkers(props.goal, presentedMessages()))
  const markersByMessageIndex = createMemo(() => {
    const markers = new Map<number, GoalTimelineMarkerEvent[]>()
    for (const marker of goalMarkers()) {
      const entries = markers.get(marker.messageIndex)
      if (entries) entries.push(marker)
      else markers.set(marker.messageIndex, [marker])
    }
    return markers
  })
  const signature = createMemo(
    () =>
      `${signatureFor(props.messages)}|goal:${goalMarkers()
        .map((marker) => `${marker.key}:${marker.messageIndex}:${marker.time}:${marker.showOrb}`)
        .join(",")}`,
  )
  const messageIDs = createMemo(() => presentedMessages().map((message) => message.info.id))
  const messagesByID = createMemo(() => new Map(presentedMessages().map((message) => [message.info.id, message])))
  const pendingActivityKeys = createMemo(() => {
    const groups = presentedMessages().flatMap((message) => message.groups)
    const keys = new Set<string>()
    let hasFormalContentAfter = false
    for (let i = groups.length - 1; i >= 0; i -= 1) {
      const group = groups[i]!
      if (group.type === "content") {
        hasFormalContentAfter = true
        continue
      }
      if (!hasFormalContentAfter) keys.add(groupKey(group))
    }
    return keys
  })
  createEffect(() => {
    if (!conversationPainted && props.messages.length > 0) {
      conversationPainted = true
      completeUIPerformanceStage("first-conversation-paint")
    }
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
                <For each={markersByMessageIndex().get(-1) ?? []}>
                  {(marker) => <GoalTimelineMarker marker={marker.marker} showOrb={marker.showOrb} />}
                </For>
                <For each={messageIDs()}>
                  {(messageID, index) => (
                    <>
                      <PresentedMessageView
                        message={messagesByID().get(messageID)!}
                        pendingActivityKeys={pendingActivityKeys()}
                      />
                      <For each={markersByMessageIndex().get(index()) ?? []}>
                        {(marker) => <GoalTimelineMarker marker={marker.marker} showOrb={marker.showOrb} />}
                      </For>
                    </>
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
