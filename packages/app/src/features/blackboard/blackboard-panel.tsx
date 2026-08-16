import type { SessionBlackboardResponse } from "@jyycode-ai/sdk/v2/client"
import { createQuery } from "@tanstack/solid-query"
import { File, Send, X } from "lucide-solid"
import { createEffect, createMemo, createSignal, For, Index, on, onCleanup, Show } from "solid-js"
import { Button, IconButton } from "../../components/ui/button"
import { useData } from "../../data/context"
import { errorMessage } from "../projects/project-controller"
import { renderMarkdown } from "../conversation/markdown"
import { tr } from "../../i18n/i18n-context"
import {
  blackboardMessagePurpose,
  blackboardQueryOptions,
  createBlackboardApi,
  type BlackboardSnapshot,
} from "./blackboard-query"
import { playSoundEffect, suppressNextBlackboardSound } from "../sound-effects/sound-effects"
import "./blackboard.css"

type BlackboardKind = "info" | "risk" | "blocker" | "decision" | "help"
type BlackboardMessage = BlackboardSnapshot["messages"][number]

const kinds: readonly BlackboardKind[] = ["info", "risk", "blocker", "decision", "help"]

function kindLabel(kind: BlackboardKind) {
  return tr(`blackboard.kind-${kind}` as Parameters<typeof tr>[0])
}

function kindGlyph(kind: BlackboardKind) {
  return { info: "i", risk: "!", blocker: "×", decision: "✓", help: "?" }[kind]
}

function replyBody(reply: unknown) {
  if (typeof reply === "string") return reply
  if (typeof reply === "object" && reply !== null && "body" in reply && typeof reply.body === "string") {
    return reply.body
  }
  return undefined
}

function replyChildren(reply: unknown): readonly unknown[] {
  if (typeof reply === "object" && reply !== null && "replies" in reply && Array.isArray(reply.replies)) {
    return reply.replies
  }
  return []
}

function replyBodies(replies: readonly unknown[]): string[] {
  return replies.flatMap((reply) => {
    const body = replyBody(reply)
    return [...(body ? [body] : []), ...replyBodies(replyChildren(reply))]
  })
}

type BlackboardMessageCursor = {
  id: string
  timeCreated: number
  replies: readonly unknown[]
}

function messageCursor(value: unknown): BlackboardMessageCursor | undefined {
  if (typeof value !== "object" || value === null || !("id" in value) || typeof value.id !== "string") return undefined
  const timeCreated =
    "timeCreated" in value && typeof value.timeCreated === "number" ? value.timeCreated : Number.NEGATIVE_INFINITY
  const replies = "replies" in value && Array.isArray(value.replies) ? value.replies : []
  return { id: value.id, timeCreated, replies }
}

function latestMessageCursor(message: BlackboardMessage) {
  let latest: Pick<BlackboardMessageCursor, "id" | "timeCreated"> = {
    id: message.id,
    timeCreated: message.timeCreated,
  }

  const visit = (replies: readonly unknown[]) => {
    for (const reply of replies) {
      const cursor = messageCursor(reply)
      if (!cursor) continue
      if (cursor.timeCreated >= latest.timeCreated) latest = { id: cursor.id, timeCreated: cursor.timeCreated }
      visit(cursor.replies)
    }
  }
  visit(message.replies)
  return latest
}

function latestVisibleMessageID(messages: readonly BlackboardMessage[]) {
  return messages.reduce<Pick<BlackboardMessageCursor, "id" | "timeCreated"> | undefined>((latest, message) => {
    const cursor = latestMessageCursor(message)
    return !latest || cursor.timeCreated >= latest.timeCreated ? cursor : latest
  }, undefined)?.id
}

function messageSender(message: BlackboardMessage, taskLabels: Record<string, string>) {
  if (message.authorKind === "user") return tr("blackboard.user")
  if (message.authorKind === "main_agent") return tr("blackboard.main-agent")
  const task = message.authorTaskID
    ? (taskLabels[message.authorTaskID] ?? message.authorTaskID)
    : tr("blackboard.all-tasks")
  return tr("blackboard.sub-agent", { task })
}

function uniqueSteps(steps: readonly { id: string; title: string }[], snapshot: SessionBlackboardResponse | undefined) {
  const result = [...steps]
  for (const id of [snapshot?.currentStepID, snapshot?.selectedStepID]) {
    if (id && !result.some((step) => step.id === id)) result.push({ id, title: id })
  }
  return result
}

/*
 * Deterministic pin placement: each note keeps a stable tilt and lift derived
 * from its message id, so the board never reshuffles between renders.
 */
function noteGeometry(id: string) {
  let hash = 0
  for (let index = 0; index < id.length; index += 1) hash = (hash * 31 + id.charCodeAt(index)) >>> 0
  const tilt = ((hash % 65) - 32) / 10 // -3.2deg … +3.2deg
  const lift = (Math.floor(hash / 65) % 12) - 6 // -6px … +5px
  const drift = (Math.floor(hash / 780) % 9) - 4 // -4px … +4px
  return { "--note-tilt": `${tilt.toFixed(1)}deg`, "--note-lift": `${lift}px`, "--note-drift": `${drift}px` }
}

/*
 * Free-form note layout: notes live at absolute positions the user can drag
 * around and overlap. Dragged positions persist to localStorage per board so
 * the arrangement survives reloads; notes never placed keep a deterministic
 * grid slot with a small hash jitter.
 */
type NotePosition = { x: number; y: number; z: number }
type BoardLayout = { zTop: number; notes: Record<string, NotePosition> }

const NOTE_SLOT_WIDTH = 200
const NOTE_SLOT_HEIGHT = 240
const NOTE_PAD_X = 28
const NOTE_PAD_Y = 44
const NOTE_HEIGHT = 250
const DEFAULT_BOARD_HEIGHT = 560

function layoutStorageKey(directory: string, rootSessionID?: string) {
  return `jyycode.blackboard.layout:${directory}:${rootSessionID ?? ""}`
}

function loadLayout(key: string): BoardLayout {
  try {
    const raw = typeof localStorage === "undefined" ? null : localStorage.getItem(key)
    if (!raw) return { zTop: 1, notes: {} }
    const parsed = JSON.parse(raw) as BoardLayout
    if (typeof parsed?.zTop !== "number" || typeof parsed?.notes !== "object" || parsed.notes === null)
      throw new Error("invalid")
    return { zTop: parsed.zTop, notes: parsed.notes }
  } catch {
    return { zTop: 1, notes: {} }
  }
}

function defaultNotePosition(id: string, index: number): NotePosition {
  let hash = 0
  for (let cursor = 0; cursor < id.length; cursor += 1) hash = (hash * 31 + id.charCodeAt(cursor)) >>> 0
  const columns = 3
  return {
    x: NOTE_PAD_X + (index % columns) * NOTE_SLOT_WIDTH + (hash % 13) - 6,
    y: NOTE_PAD_Y + Math.floor(index / columns) * NOTE_SLOT_HEIGHT + (Math.floor(hash / 13) % 11) - 5,
    z: 1,
  }
}

export type BlackboardPanelProps = {
  directory: string
  enabled?: boolean
  /**
   * Single-agent Sessions keep the board readable but read-only: neither the
   * user nor agents may publish new messages until multi-agent is re-enabled.
   */
  postingEnabled?: boolean
  waitingForPlan?: boolean
  rootSessionID?: string
  steps?: readonly { id: string; title: string }[]
  taskLabels?: Record<string, string>
}

export function BlackboardPanel(props: BlackboardPanelProps) {
  const data = useData()
  const enabled = () => props.enabled !== false
  const posting = () => props.postingEnabled !== false
  const [selectedStep, setSelectedStep] = createSignal<string>()
  const [selectedTask, setSelectedTask] = createSignal<string>("all")
  const [draft, setDraft] = createSignal("")
  const [kind, setKind] = createSignal<BlackboardKind>("info")
  const [sending, setSending] = createSignal(false)
  const [submitError, setSubmitError] = createSignal<string>()
  const [expandedID, setExpandedID] = createSignal<string>()
  const [layout, setLayout] = createSignal<BoardLayout>(
    loadLayout(layoutStorageKey(props.directory, props.rootSessionID)),
  )
  const [draggingID, setDraggingID] = createSignal<string>()
  const [boardElement, setBoardElement] = createSignal<HTMLDivElement>()
  const [boardViewportHeight, setBoardViewportHeight] = createSignal(0)
  let suppressClick = false
  const markedThrough = new Map<string, string>()

  createEffect(
    on(
      () => [props.directory, props.rootSessionID] as const,
      () => setLayout(loadLayout(layoutStorageKey(props.directory, props.rootSessionID))),
    ),
  )

  createEffect(() => {
    const element = boardElement()
    if (!element) return
    const measure = () => setBoardViewportHeight(element.clientHeight)
    measure()
    if (typeof ResizeObserver === "undefined") return
    const observer = new ResizeObserver(measure)
    observer.observe(element)
    onCleanup(() => observer.disconnect())
  })

  // Notes must stay inside the visible board so a low note can neither
  // disappear below the fold nor stretch the panel and squeeze the composer.
  const maxNoteY = createMemo(() => Math.max(NOTE_PAD_Y, (boardViewportHeight() || DEFAULT_BOARD_HEIGHT) - NOTE_HEIGHT))

  function notePosition(id: string, index: number): NotePosition {
    const position = layout().notes[id] ?? defaultNotePosition(id, index)
    return { ...position, y: Math.min(Math.max(0, position.y), maxNoteY()) }
  }

  function persistLayout() {
    try {
      localStorage.setItem(layoutStorageKey(props.directory, props.rootSessionID), JSON.stringify(layout()))
    } catch {
      // Storage may be unavailable; dragging still works for the session.
    }
  }

  function startDrag(event: PointerEvent, id: string, index: number) {
    if (event.button !== 0) return
    event.preventDefault()
    // A fresh press starts a new gesture; clear any stale click suppression.
    suppressClick = false
    const start = notePosition(id, index)
    const origin = { x: event.clientX, y: event.clientY }
    let latest = start
    let moved = false
    // Dragging a note lifts it above every overlapping note.
    setLayout((current) => {
      const zTop = current.zTop + 1
      latest = { ...start, z: zTop }
      return { zTop, notes: { ...current.notes, [id]: latest } }
    })
    setDraggingID(id)
    const move = (next: PointerEvent) => {
      const dx = next.clientX - origin.x
      const dy = next.clientY - origin.y
      if (!moved && Math.abs(dx) + Math.abs(dy) < 4) return
      moved = true
      latest = {
        ...latest,
        x: Math.max(0, start.x + dx),
        y: Math.min(Math.max(0, start.y + dy), maxNoteY()),
      }
      setLayout((current) => ({ ...current, notes: { ...current.notes, [id]: latest } }))
    }
    const up = () => {
      window.removeEventListener("pointermove", move)
      window.removeEventListener("pointerup", up)
      window.removeEventListener("pointercancel", up)
      setDraggingID(undefined)
      if (!moved) return
      // A real drag must not fall through to the note's click-to-expand.
      suppressClick = true
      setTimeout(() => {
        suppressClick = false
      }, 0)
      persistLayout()
    }
    window.addEventListener("pointermove", move)
    window.addEventListener("pointerup", up)
    window.addEventListener("pointercancel", up)
  }

  const query = createQuery(
    () => ({
      ...blackboardQueryOptions({
        client: data.client(),
        directory: props.directory,
        rootSessionID: props.rootSessionID ?? "",
        stepID: selectedStep(),
      }),
      enabled: enabled() && Boolean(props.rootSessionID),
    }),
    data.queryClient,
  )
  const api = createMemo(() =>
    createBlackboardApi({
      client: data.client(),
      directory: props.directory,
      rootSessionID: props.rootSessionID ?? "",
      queryClient: data.queryClient(),
    }),
  )
  const snapshot = createMemo(() => query.data as BlackboardSnapshot | undefined)
  const activeStep = createMemo(() => selectedStep() ?? snapshot()?.selectedStepID ?? snapshot()?.currentStepID ?? "")
  const stepOptions = createMemo(() => uniqueSteps(props.steps ?? [], snapshot()))
  const tasks = createMemo(() => snapshot()?.tasks ?? [])
  const taskLabels = () => props.taskLabels ?? {}
  const visibleMessages = createMemo(() => {
    const task = selectedTask()
    return [...(snapshot()?.messages ?? [])]
      .filter((message) => message.stepID === activeStep())
      .filter((message) => task === "all" || message.taskIDs.includes(task))
      .sort((left, right) => left.timeCreated - right.timeCreated)
  })
  const expandedMessage = createMemo(() => visibleMessages().find((message) => message.id === expandedID()))
  const readonly = createMemo(
    () =>
      Boolean(snapshot()?.readonly) ||
      (Boolean(snapshot()?.currentStepID) && Boolean(activeStep()) && snapshot()?.currentStepID !== activeStep()),
  )
  const canCompose = createMemo(
    () =>
      posting() &&
      enabled() &&
      Boolean(props.rootSessionID) &&
      Boolean(snapshot()?.currentStepID) &&
      !readonly() &&
      !query.error,
  )

  createEffect(() => {
    const current = snapshot()?.currentStepID
    if (!current || selectedStep() !== undefined) return
    setSelectedStep(current)
  })

  createEffect(
    on(
      () => selectedStep(),
      (next, previous) => {
        if (next && previous !== undefined && next !== previous) void query.refetch()
      },
    ),
  )

  createEffect(() => {
    const messages = visibleMessages()
    const stepID = activeStep()
    const throughMessageID = latestVisibleMessageID(messages)
    if (!throughMessageID || !stepID || !props.rootSessionID || markedThrough.get(stepID) === throughMessageID) return
    markedThrough.set(stepID, throughMessageID)
    void api()
      .markRead({ stepID, throughMessageID })
      .catch(() => {
        if (markedThrough.get(stepID) === throughMessageID) markedThrough.delete(stepID)
      })
  })

  createEffect(() => {
    if (!expandedID()) return
    const close = (event: KeyboardEvent) => {
      if (event.key === "Escape") setExpandedID(undefined)
    }
    document.addEventListener("keydown", close)
    onCleanup(() => document.removeEventListener("keydown", close))
  })

  function openNote(id: string) {
    if (suppressClick) return
    const selection = typeof window === "undefined" ? null : window.getSelection()
    if (selection && !selection.isCollapsed) return
    setExpandedID(id)
  }

  function selectStep(stepID: string) {
    setSelectedStep(stepID)
    setSelectedTask("all")
  }

  async function submit() {
    if (!canCompose() || sending() || !draft().trim()) return
    setSending(true)
    setSubmitError(undefined)
    try {
      await api().post({
        message: draft().trim(),
        kind: kind(),
      })
      setDraft("")
      playSoundEffect("send")
      suppressNextBlackboardSound()
    } catch (cause) {
      setSubmitError(errorMessage(cause, tr("blackboard.unable-to-load")))
      playSoundEffect("error")
    } finally {
      setSending(false)
    }
  }

  return (
    <section class="blackboard-panel" aria-label={tr("blackboard.title")}>
      <header class="blackboard-panel__header">
        <div>
          <h2>{tr("blackboard.title")}</h2>
        </div>
        <div class="blackboard-panel__filters">
          <label>
            <span>{tr("blackboard.current-step")}</span>
            <select
              aria-label={tr("blackboard.current-step")}
              value={activeStep()}
              onChange={(event) => selectStep(event.currentTarget.value)}
            >
              <For each={stepOptions()}>{(step) => <option value={step.id}>{step.title}</option>}</For>
            </select>
          </label>
          <label>
            <span>{tr("blackboard.task-filter")}</span>
            <select
              aria-label={tr("blackboard.task-filter")}
              value={selectedTask()}
              onChange={(event) => setSelectedTask(event.currentTarget.value)}
            >
              <option value="all">{tr("blackboard.all-tasks")}</option>
              <For each={tasks()}>
                {(task) => <option value={task.id}>{taskLabels()[task.id] ?? task.title}</option>}
              </For>
            </select>
          </label>
          <Show when={Number(snapshot()?.unreadCount ?? 0) > 0}>
            <span class="blackboard-panel__unread">{Number(snapshot()?.unreadCount ?? 0)}</span>
          </Show>
        </div>
      </header>

      <Show when={!enabled()}>
        <p class="blackboard-panel__empty">
          {tr(props.waitingForPlan ? "blackboard.waiting-for-plan" : "blackboard.multi-agent-only")}
        </p>
      </Show>
      <Show when={enabled() && !props.rootSessionID}>
        <p class="blackboard-panel__empty">{tr("blackboard.no-plan")}</p>
      </Show>
      <Show when={enabled() && props.rootSessionID && query.isPending}>
        <p class="blackboard-panel__empty" role="status">
          {tr("blackboard.loading")}
        </p>
      </Show>
      <Show when={enabled() && query.error}>
        <div class="blackboard-panel__empty">
          <p>{errorMessage(query.error, tr("blackboard.unable-to-load"))}</p>
          <Button size="small" variant="secondary" onClick={() => void query.refetch()}>
            {tr("blackboard.retry")}
          </Button>
        </div>
      </Show>
      <Show when={enabled() && props.rootSessionID && !query.isPending && !query.error}>
        <div class="blackboard-board" aria-live="polite" ref={setBoardElement}>
          <Show
            when={visibleMessages().length > 0}
            fallback={<p class="blackboard-panel__empty">{tr("blackboard.no-messages")}</p>}
          >
            <Index each={visibleMessages()}>
              {(message, index) => {
                const replies = () => replyBodies(message().replies)
                const position = () => notePosition(message().id, index)
                return (
                  <article
                    class="blackboard-note"
                    data-kind={message().kind}
                    data-author={message().authorKind}
                    data-message-id={message().id}
                    data-dragging={draggingID() === message().id || undefined}
                    style={{
                      left: `${position().x}px`,
                      top: `${position().y}px`,
                      "z-index": String(position().z),
                      ...noteGeometry(message().id),
                    }}
                    role="button"
                    tabIndex={0}
                    aria-label={`${tr("blackboard.open-note")}: ${messageSender(message(), taskLabels())}`}
                    onClick={() => openNote(message().id)}
                    onKeyDown={(event) => {
                      if (event.key !== "Enter" && event.key !== " ") return
                      event.preventDefault()
                      openNote(message().id)
                    }}
                  >
                    <span class="blackboard-note__pin" aria-hidden="true" />
                    <header
                      class="blackboard-note__header"
                      onPointerDown={(event) => startDrag(event, message().id, index)}
                    >
                      <span class="blackboard-note__kind" aria-label={kindLabel(message().kind)}>
                        <span aria-hidden="true">{kindGlyph(message().kind)}</span> {kindLabel(message().kind)}
                      </span>
                      <Show when={blackboardMessagePurpose(message()) === "candidate_declaration"}>
                        <span class="blackboard-note__purpose">{tr("blackboard.candidate-declaration")}</span>
                      </Show>
                      <strong>{messageSender(message(), taskLabels())}</strong>
                      <time dateTime={new Date(message().timeCreated).toISOString()}>
                        {new Date(message().timeCreated).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
                      </time>
                    </header>
                    <div class="blackboard-note__body" innerHTML={renderMarkdown(message().body)} />
                    <Show when={replies().length > 0}>
                      <span class="blackboard-note__reply-count">
                        {tr("blackboard.replies", { count: replies().length })}
                      </span>
                    </Show>
                  </article>
                )
              }}
            </Index>
          </Show>
        </div>
      </Show>

      <Show when={expandedMessage()}>
        {(message) => {
          const replies = () => replyBodies(message().replies)
          return (
            <div class="blackboard-note-overlay" role="presentation" onClick={() => setExpandedID(undefined)}>
              <article
                class="blackboard-note blackboard-note--expanded"
                data-kind={message().kind}
                data-author={message().authorKind}
                data-message-id={message().id}
                style={noteGeometry(message().id)}
                role="dialog"
                aria-modal="true"
                aria-label={messageSender(message(), taskLabels())}
                onClick={(event) => event.stopPropagation()}
              >
                <span class="blackboard-note__pin" aria-hidden="true" />
                <button
                  type="button"
                  class="blackboard-note__close"
                  aria-label={tr("blackboard.close-note")}
                  onClick={() => setExpandedID(undefined)}
                >
                  <X aria-hidden="true" />
                </button>
                <header class="blackboard-note__header">
                  <span class="blackboard-note__kind" aria-label={kindLabel(message().kind)}>
                    <span aria-hidden="true">{kindGlyph(message().kind)}</span> {kindLabel(message().kind)}
                  </span>
                  <Show when={blackboardMessagePurpose(message()) === "candidate_declaration"}>
                    <span class="blackboard-note__purpose">{tr("blackboard.candidate-declaration")}</span>
                  </Show>
                  <strong>{messageSender(message(), taskLabels())}</strong>
                  <time dateTime={new Date(message().timeCreated).toISOString()}>
                    {new Date(message().timeCreated).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
                  </time>
                </header>
                <div class="blackboard-note__body" innerHTML={renderMarkdown(message().body)} />
                <Show when={message().taskIDs.length > 0}>
                  <div class="blackboard-note__chips" aria-label={tr("blackboard.task-filter")}>
                    <For each={message().taskIDs}>
                      {(taskID) => <span class="blackboard-note__chip">{taskLabels()[taskID] ?? taskID}</span>}
                    </For>
                  </div>
                </Show>
                <Show when={message().attachments.length > 0}>
                  <ul class="blackboard-note__attachments" aria-label={tr("blackboard.attachments")}>
                    <For each={message().attachments}>
                      {(attachment) => (
                        <li>
                          <File aria-hidden="true" />
                          <button
                            type="button"
                            data-sound-effect="copy"
                            onClick={() => void navigator.clipboard?.writeText(attachment.value)}
                          >
                            {attachment.value}
                          </button>
                        </li>
                      )}
                    </For>
                  </ul>
                </Show>
                <Show when={replies().length > 0}>
                  <div
                    class="blackboard-note__replies"
                    aria-label={tr("blackboard.replies", { count: replies().length })}
                  >
                    <For each={replies()}>{(reply) => <div class="blackboard-note__reply">{reply}</div>}</For>
                  </div>
                </Show>
              </article>
            </div>
          )
        }}
      </Show>

      <Show when={enabled() && props.rootSessionID && !posting()}>
        <p class="blackboard-panel__readonly" role="note">
          {tr("blackboard.single-agent-readonly")}
        </p>
      </Show>
      <Show when={posting() && readonly() && props.rootSessionID}>
        <p class="blackboard-panel__readonly" role="note">
          {tr("blackboard.readonly")}
        </p>
      </Show>
      <Show when={canCompose()}>
        <div class="blackboard-composer" aria-label={tr("blackboard.send")}>
          <label class="blackboard-composer__kind">
            <span>{tr("blackboard.message-kind")}</span>
            <select
              aria-label={tr("blackboard.message-kind")}
              value={kind()}
              onChange={(event) => setKind(event.currentTarget.value as BlackboardKind)}
            >
              <For each={kinds}>{(value) => <option value={value}>{kindLabel(value)}</option>}</For>
            </select>
          </label>
          <textarea
            aria-label={tr("blackboard.message-placeholder")}
            placeholder={tr("blackboard.message-placeholder")}
            rows={1}
            value={draft()}
            onInput={(event) => setDraft(event.currentTarget.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) {
                event.preventDefault()
                void submit()
              }
            }}
          />
          <IconButton
            class="blackboard-composer__send"
            data-sound-effect="none"
            label={tr("blackboard.send")}
            variant="primary"
            disabled={sending() || !draft().trim()}
            loading={sending()}
            loadingLabel={tr("blackboard.sending")}
            onClick={() => void submit()}
          >
            <Send aria-hidden="true" />
          </IconButton>
          <Show when={submitError()}>
            <p class="blackboard-composer__error" role="alert">
              {submitError()}
            </p>
          </Show>
        </div>
      </Show>
    </section>
  )
}
