import type { SessionBlackboardResponse } from "@jyycode-ai/sdk/v2/client"
import { createQuery } from "@tanstack/solid-query"
import { AtSign, ChevronDown, File, MessageSquareReply, Paperclip, Send, X } from "lucide-solid"
import { createEffect, createMemo, createSignal, For, on, onCleanup, onMount, Show } from "solid-js"
import { Button, IconButton } from "../../components/ui/button"
import { useData } from "../../data/context"
import { errorMessage } from "../projects/project-controller"
import { attachmentFromPath } from "../composer/composer"
import { renderMarkdown } from "../conversation/markdown"
import { tr } from "../../i18n/i18n-context"
import { blackboardQueryOptions, createBlackboardApi, type BlackboardSnapshot } from "./blackboard-query"
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

export type BlackboardPanelProps = {
  directory: string
  rootSessionID?: string
  steps?: readonly { id: string; title: string }[]
  taskLabels?: Record<string, string>
}

export function BlackboardPanel(props: BlackboardPanelProps) {
  const data = useData()
  const [selectedStep, setSelectedStep] = createSignal<string>()
  const [selectedTask, setSelectedTask] = createSignal<string>("all")
  const [draft, setDraft] = createSignal("")
  const [kind, setKind] = createSignal<BlackboardKind>("info")
  const [taskIDs, setTaskIDs] = createSignal<string[]>([])
  const [replyTo, setReplyTo] = createSignal<BlackboardMessage>()
  const [attachments, setAttachments] = createSignal<Array<{ name: string; value: string }>>([])
  const [attachmentPath, setAttachmentPath] = createSignal("")
  const [sending, setSending] = createSignal(false)
  const [submitError, setSubmitError] = createSignal<string>()
  const markedSteps = new Set<string>()
  const [draggingFiles, setDraggingFiles] = createSignal(false)
  let fileInput!: HTMLInputElement
  let inputRegion!: HTMLDivElement

  const query = createQuery(
    () => ({
      ...blackboardQueryOptions({
        client: data.client(),
        directory: props.directory,
        rootSessionID: props.rootSessionID ?? "",
        stepID: selectedStep(),
      }),
      enabled: Boolean(props.rootSessionID),
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
    () => Boolean(props.rootSessionID) && Boolean(snapshot()?.currentStepID) && !readonly() && !query.error,
  )
  const mentionOpen = createMemo(() => /(^|\s)@[\w-]*$/u.test(draft()))

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
    const last = visibleMessages().at(-1)
    const stepID = activeStep()
    if (!last || !stepID || markedSteps.has(stepID) || !props.rootSessionID) return
    markedSteps.add(stepID)
    void api().markRead({ stepID: last.stepID, throughMessageID: last.id })
  })

  onMount(() => {
    if (!("__TAURI_INTERNALS__" in window)) return
    let unlisten: (() => void) | undefined
    let disposed = false
    void import("@tauri-apps/api/webview").then(async ({ getCurrentWebview }) => {
      if (disposed) return
      unlisten = await getCurrentWebview().onDragDropEvent((event) => {
        const payload = event.payload
        if (payload.type === "leave") {
          setDraggingFiles(false)
          return
        }
        const scale = window.devicePixelRatio || 1
        const x = payload.position.x / scale
        const y = payload.position.y / scale
        const bounds = inputRegion?.getBoundingClientRect()
        const inside = Boolean(bounds && x >= bounds.left && x <= bounds.right && y >= bounds.top && y <= bounds.bottom)
        if (payload.type !== "drop") {
          setDraggingFiles(inside)
          return
        }
        setDraggingFiles(false)
        if (inside) for (const path of payload.paths) addAttachment(path)
      })
      if (disposed) unlisten?.()
    })
    onCleanup(() => {
      disposed = true
      unlisten?.()
    })
  })

  function selectStep(stepID: string) {
    setSelectedStep(stepID)
    setSelectedTask("all")
    setReplyTo(undefined)
  }

  function toggleTask(taskID: string) {
    setTaskIDs((current) =>
      current.includes(taskID) ? current.filter((id) => id !== taskID) : [...current, taskID],
    )
  }

  function addAttachment(value: string) {
    const trimmed = value.trim()
    if (!trimmed) return
    const attachment = /^https?:\/\//u.test(trimmed)
      ? { filename: trimmed, url: trimmed }
      : attachmentFromPath(trimmed)
    setAttachments((current) =>
      current.some((item) => item.value === attachment.url)
        ? current
        : [...current, { name: attachment.filename, value: attachment.url }],
    )
    setAttachmentPath("")
  }

  function mention(value: string) {
    setDraft((current) => current.replace(/(^|\s)@[\w-]*$/u, `$1${value} `))
  }

  async function submit() {
    if (!canCompose() || sending() || !draft().trim()) return
    setSending(true)
    setSubmitError(undefined)
    try {
      await api().post({
        message: draft().trim(),
        kind: kind(),
        taskIDs: taskIDs(),
        ...(replyTo()?.id ? { replyTo: replyTo()!.id } : {}),
        attachments: attachments().map((attachment) => attachment.value),
      })
      setDraft("")
      setAttachments([])
      setReplyTo(undefined)
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
          <span class="blackboard-panel__root">{props.rootSessionID ?? ""}</span>
        </div>
        <Show when={Number(snapshot()?.unreadCount ?? 0) > 0}>
          <span class="blackboard-panel__unread">{Number(snapshot()?.unreadCount ?? 0)}</span>
        </Show>
      </header>

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
      </div>

      <Show when={!props.rootSessionID}>
        <p class="blackboard-panel__empty">{tr("blackboard.no-plan")}</p>
      </Show>
      <Show when={props.rootSessionID && query.isPending}>
        <p class="blackboard-panel__empty" role="status">{tr("blackboard.loading")}</p>
      </Show>
      <Show when={query.error}>
        <div class="blackboard-panel__empty">
          <p>{errorMessage(query.error, tr("blackboard.unable-to-load"))}</p>
          <Button size="small" variant="secondary" onClick={() => void query.refetch()}>
            {tr("blackboard.retry")}
          </Button>
        </div>
      </Show>
      <Show when={props.rootSessionID && !query.isPending && !query.error}>
        <div class="blackboard-panel__timeline" aria-live="polite">
          <Show when={visibleMessages().length > 0} fallback={<p class="blackboard-panel__empty">{tr("blackboard.no-messages")}</p>}>
            <For each={visibleMessages()}>
              {(message) => {
                const replies = () => message.replies.flatMap((reply) => (replyBody(reply) ? [replyBody(reply)!] : []))
                return (
                  <article class="blackboard-message" data-kind={message.kind} data-message-id={message.id}>
                    <header class="blackboard-message__header">
                      <span class="blackboard-message__kind" aria-label={kindLabel(message.kind)}>
                        <span aria-hidden="true">{kindGlyph(message.kind)}</span> {kindLabel(message.kind)}
                      </span>
                      <strong>{messageSender(message, taskLabels())}</strong>
                      <time dateTime={new Date(message.timeCreated).toISOString()}>
                        {new Date(message.timeCreated).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
                      </time>
                    </header>
                    <div class="blackboard-message__body" innerHTML={renderMarkdown(message.body)} />
                    <Show when={message.taskIDs.length > 0}>
                      <div class="blackboard-message__chips" aria-label={tr("blackboard.task-filter")}>
                        <For each={message.taskIDs}>
                          {(taskID) => <span class="blackboard-chip">{taskLabels()[taskID] ?? taskID}</span>}
                        </For>
                      </div>
                    </Show>
                    <Show when={message.attachments.length > 0}>
                      <ul class="blackboard-message__attachments" aria-label={tr("blackboard.add-attachment")}>
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
                    <footer class="blackboard-message__footer">
                      <Button size="small" variant="ghost" onClick={() => setReplyTo(message)}>
                        <MessageSquareReply aria-hidden="true" />
                        {tr("blackboard.reply")}
                      </Button>
                      <Show when={replies().length > 0}>
                        <details class="blackboard-message__reply-details">
                          <summary class="ui-button" aria-label={`${tr("blackboard.show-replies")} (${replies().length})`}>
                            <ChevronDown aria-hidden="true" />
                            {tr("blackboard.show-replies")} ({replies().length})
                          </summary>
                          <div class="blackboard-message__replies">
                            <For each={replies()}>{(reply) => <div class="blackboard-reply">{reply}</div>}</For>
                          </div>
                        </details>
                      </Show>
                    </footer>
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
        <div
          ref={inputRegion}
          class="blackboard-composer"
          aria-label={tr("blackboard.send")}
          data-dragging={draggingFiles()}
          onDragOver={(event) => {
            if (!event.dataTransfer?.types.includes("Files")) return
            event.preventDefault()
            setDraggingFiles(true)
          }}
          onDragLeave={() => setDraggingFiles(false)}
          onDrop={(event) => {
            event.preventDefault()
            setDraggingFiles(false)
            if (event.dataTransfer?.files.length) {
              for (const file of Array.from(event.dataTransfer.files)) addAttachment(file.name)
            }
          }}
        >
          <Show when={replyTo()}>
            {(message) => (
              <div class="blackboard-composer__reply">
                <span>{tr("blackboard.replying-to", { sender: messageSender(message(), taskLabels()) })}</span>
                <IconButton label={tr("blackboard.clear-reply")} variant="ghost" onClick={() => setReplyTo(undefined)}>
                  <X aria-hidden="true" />
                </IconButton>
              </div>
            )}
          </Show>
          <Show when={tasks().length > 0}>
            <div class="blackboard-composer__tasks" aria-label={tr("blackboard.all-tasks")}>
              <For each={tasks()}>
                {(task) => (
                  <button
                    type="button"
                    class="blackboard-chip"
                    aria-pressed={taskIDs().includes(task.id)}
                    onClick={() => toggleTask(task.id)}
                  >
                    {taskLabels()[task.id] ?? task.title}
                  </button>
                )}
              </For>
            </div>
          </Show>
          <div class="blackboard-composer__controls">
            <label>
              <span>{tr("blackboard.message-kind")}</span>
              <select aria-label={tr("blackboard.message-kind")} value={kind()} onChange={(event) => setKind(event.currentTarget.value as BlackboardKind)}>
                <For each={kinds}>{(value) => <option value={value}>{kindLabel(value)}</option>}</For>
              </select>
            </label>
            <Show when={mentionOpen()}>
              <div class="blackboard-mentions" role="listbox" aria-label={tr("blackboard.mention-suggestion")}>
                <button type="button" role="option" onClick={() => mention("@main")}>
                  <AtSign aria-hidden="true" /> {tr("blackboard.mention-suggestion", { name: tr("blackboard.main-agent") })}
                </button>
                <For each={tasks()}>
                  {(task) => (
                    <button type="button" role="option" onClick={() => mention(`@${task.id}`)}>
                      <AtSign aria-hidden="true" /> {tr("blackboard.mention-suggestion", { name: taskLabels()[task.id] ?? task.title })}
                    </button>
                  )}
                </For>
              </div>
            </Show>
          </div>
          <textarea
            aria-label={tr("blackboard.message-placeholder")}
            placeholder={tr("blackboard.message-placeholder")}
            rows={2}
            value={draft()}
            onInput={(event) => setDraft(event.currentTarget.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) {
                event.preventDefault()
                void submit()
              }
            }}
          />
          <Show when={attachments().length > 0}>
            <ul class="blackboard-composer__attachments" aria-label={tr("blackboard.add-attachment")}>
              <For each={attachments()}>
                {(attachment, index) => (
                  <li>
                    <Paperclip aria-hidden="true" />
                    <span>{attachment.name}</span>
                    <IconButton
                      label={tr("blackboard.remove-attachment", { name: attachment.name })}
                      variant="ghost"
                      onClick={() => setAttachments((current) => current.filter((_, itemIndex) => itemIndex !== index()))}
                    >
                      <X aria-hidden="true" />
                    </IconButton>
                  </li>
                )}
              </For>
            </ul>
          </Show>
          <div class="blackboard-composer__footer">
            <input
              ref={fileInput}
              class="blackboard-composer__file-input"
              type="file"
              multiple
              aria-label={tr("blackboard.choose-files")}
              onChange={(event) => {
                for (const file of Array.from(event.currentTarget.files ?? [])) addAttachment(file.name)
                event.currentTarget.value = ""
              }}
            />
            <IconButton label={tr("blackboard.add-attachment")} variant="ghost" onClick={() => fileInput.click()}>
              <Paperclip aria-hidden="true" />
            </IconButton>
            <input
              aria-label={tr("blackboard.attachment-path")}
              placeholder={tr("blackboard.attachment-path")}
              value={attachmentPath()}
              onInput={(event) => setAttachmentPath(event.currentTarget.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter") {
                  event.preventDefault()
                  addAttachment(attachmentPath())
                }
              }}
            />
            <Button size="small" variant="ghost" onClick={() => addAttachment(attachmentPath())}>
              {tr("blackboard.add-path")}
            </Button>
            <Button size="small" variant="primary" disabled={sending() || !draft().trim()} loading={sending()} loadingLabel={tr("blackboard.sending")} onClick={() => void submit()}>
              <Send aria-hidden="true" />
              {tr("blackboard.send")}
            </Button>
          </div>
          <Show when={submitError()}>
            <p class="blackboard-composer__error" role="alert">{submitError()}</p>
          </Show>
        </div>
      </Show>
    </section>
  )
}
