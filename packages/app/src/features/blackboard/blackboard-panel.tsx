import type { SessionBlackboardResponse } from "@jyycode-ai/sdk/v2/client"
import { createQuery } from "@tanstack/solid-query"
import { ChevronDown, File, Send } from "lucide-solid"
import { createEffect, createMemo, createSignal, For, on, Show } from "solid-js"
import { Button, IconButton } from "../../components/ui/button"
import { useData } from "../../data/context"
import { errorMessage } from "../projects/project-controller"
import { renderMarkdown } from "../conversation/markdown"
import { tr } from "../../i18n/i18n-context"
import { blackboardMessagePurpose, blackboardQueryOptions, createBlackboardApi, type BlackboardSnapshot } from "./blackboard-query"
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
  const timeCreated = "timeCreated" in value && typeof value.timeCreated === "number" ? value.timeCreated : Number.NEGATIVE_INFINITY
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
  const task = message.authorTaskID ? taskLabels[message.authorTaskID] ?? message.authorTaskID : tr("blackboard.all-tasks")
  return tr("blackboard.sub-agent", { task })
}

function uniqueSteps(
  steps: readonly { id: string; title: string }[],
  snapshot: SessionBlackboardResponse | undefined,
) {
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

export type BlackboardPanelProps = {
  directory: string
  enabled?: boolean
  waitingForPlan?: boolean
  planCompleted?: boolean
  rootSessionID?: string
  steps?: readonly { id: string; title: string }[]
  taskLabels?: Record<string, string>
}

export function BlackboardPanel(props: BlackboardPanelProps) {
  const data = useData()
  const enabled = () => props.enabled !== false
  const [selectedStep, setSelectedStep] = createSignal<string>()
  const [selectedTask, setSelectedTask] = createSignal<string>("all")
  const [draft, setDraft] = createSignal("")
  const [kind, setKind] = createSignal<BlackboardKind>("info")
  const [sending, setSending] = createSignal(false)
  const [submitError, setSubmitError] = createSignal<string>()
  const markedThrough = new Map<string, string>()

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
  const readonly = createMemo(
    () =>
      Boolean(snapshot()?.readonly) ||
      (Boolean(snapshot()?.currentStepID) && Boolean(activeStep()) && snapshot()?.currentStepID !== activeStep()),
  )
  const canCompose = createMemo(
    () => enabled() && Boolean(props.rootSessionID) && Boolean(snapshot()?.currentStepID) && !readonly() && !query.error,
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
    } catch (cause) {
      setSubmitError(errorMessage(cause, tr("blackboard.unable-to-load")))
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
            <select aria-label={tr("blackboard.current-step")} value={activeStep()} onChange={(event) => selectStep(event.currentTarget.value)}>
              <For each={stepOptions()}>{(step) => <option value={step.id}>{step.title}</option>}</For>
            </select>
          </label>
          <label>
            <span>{tr("blackboard.task-filter")}</span>
            <select aria-label={tr("blackboard.task-filter")} value={selectedTask()} onChange={(event) => setSelectedTask(event.currentTarget.value)}>
              <option value="all">{tr("blackboard.all-tasks")}</option>
              <For each={tasks()}>{(task) => <option value={task.id}>{taskLabels()[task.id] ?? task.title}</option>}</For>
            </select>
          </label>
          <Show when={Number(snapshot()?.unreadCount ?? 0) > 0}>
            <span class="blackboard-panel__unread">{Number(snapshot()?.unreadCount ?? 0)}</span>
          </Show>
        </div>
      </header>

      <Show when={!enabled()}>
        <p class="blackboard-panel__empty">
          {tr(
            props.planCompleted
              ? "blackboard.plan-complete"
              : props.waitingForPlan
                ? "blackboard.waiting-for-plan"
                : "blackboard.multi-agent-only",
          )}
        </p>
      </Show>
      <Show when={enabled() && !props.rootSessionID}>
        <p class="blackboard-panel__empty">{tr("blackboard.no-plan")}</p>
      </Show>
      <Show when={enabled() && props.rootSessionID && query.isPending}>
        <p class="blackboard-panel__empty" role="status">{tr("blackboard.loading")}</p>
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
        <div class="blackboard-board" aria-live="polite">
          <Show when={visibleMessages().length > 0} fallback={<p class="blackboard-panel__empty">{tr("blackboard.no-messages")}</p>}>
            <For each={visibleMessages()}>
              {(message) => {
                const replies = () => replyBodies(message.replies)
                return (
                  <article
                    class="blackboard-note"
                    data-kind={message.kind}
                    data-author={message.authorKind}
                    data-message-id={message.id}
                    style={noteGeometry(message.id)}
                  >
                    <span class="blackboard-note__pin" aria-hidden="true" />
                    <header class="blackboard-note__header">
                      <span class="blackboard-note__kind" aria-label={kindLabel(message.kind)}>
                        <span aria-hidden="true">{kindGlyph(message.kind)}</span> {kindLabel(message.kind)}
                      </span>
                      <Show when={blackboardMessagePurpose(message) === "candidate_declaration"}>
                        <span class="blackboard-note__purpose">{tr("blackboard.candidate-declaration")}</span>
                      </Show>
                      <strong>{messageSender(message, taskLabels())}</strong>
                      <time dateTime={new Date(message.timeCreated).toISOString()}>
                        {new Date(message.timeCreated).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
                      </time>
                    </header>
                    <div class="blackboard-note__body" innerHTML={renderMarkdown(message.body)} />
                    <Show when={message.taskIDs.length > 0}>
                      <div class="blackboard-note__chips" aria-label={tr("blackboard.task-filter")}>
                        <For each={message.taskIDs}>
                          {(taskID) => <span class="blackboard-note__chip">{taskLabels()[taskID] ?? taskID}</span>}
                        </For>
                      </div>
                    </Show>
                    <Show when={message.attachments.length > 0}>
                      <ul class="blackboard-note__attachments" aria-label={tr("blackboard.attachments")}>
                        <For each={message.attachments}>
                          {(attachment) => (
                            <li>
                              <File aria-hidden="true" />
                              <button type="button" onClick={() => void navigator.clipboard?.writeText(attachment.value)}>
                                {attachment.value}
                              </button>
                            </li>
                          )}
                        </For>
                      </ul>
                    </Show>
                    <Show when={replies().length > 0}>
                      <details class="blackboard-note__reply-details">
                        <summary aria-label={`${tr("blackboard.show-replies")} (${replies().length})`}>
                          <ChevronDown aria-hidden="true" />
                          {tr("blackboard.show-replies")} ({replies().length})
                        </summary>
                        <div class="blackboard-note__replies">
                          <For each={replies()}>{(reply) => <div class="blackboard-note__reply">{reply}</div>}</For>
                        </div>
                      </details>
                    </Show>
                  </article>
                )
              }}
            </For>
          </Show>
        </div>
      </Show>

      <Show when={readonly() && props.rootSessionID}>
        <p class="blackboard-panel__readonly" role="note">{tr("blackboard.readonly")}</p>
      </Show>
      <Show when={canCompose()}>
        <div class="blackboard-composer" aria-label={tr("blackboard.send")}>
          <label class="blackboard-composer__kind">
            <span>{tr("blackboard.message-kind")}</span>
            <select aria-label={tr("blackboard.message-kind")} value={kind()} onChange={(event) => setKind(event.currentTarget.value as BlackboardKind)}>
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
            <p class="blackboard-composer__error" role="alert">{submitError()}</p>
          </Show>
        </div>
      </Show>
    </section>
  )
}
