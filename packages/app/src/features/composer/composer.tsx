import { tr } from "../../i18n/i18n-context"
import type { Agent, SessionStatus } from "@jyycode-ai/sdk/v2/client"
import type { QueryClient } from "@tanstack/solid-query"
import { File, ListPlus, OctagonX, Plus, RotateCcw, Send, Square, X } from "lucide-solid"
import { createEffect, createSignal, For, onCleanup, onMount, Show, type JSX } from "solid-js"
import { Button, IconButton } from "../../components/ui/button"
import { BorderBeam } from "../../components/ui/border-beam"
import { InlineError } from "../../components/ui/inline-error"
import type { DesktopClient } from "../../data/sdk"
import { keys } from "../../data/query-keys"
import { isConversationSnapshot, type ConversationSnapshot } from "../conversation/conversation-state"
import { errorMessage } from "../projects/project-controller"
import { AgentSelect } from "./agent-select"
import { createComposerController, type ComposerAttachment } from "./composer-controller"
import { createComposerQueue, type ComposerQueueStore } from "./composer-queue"
import { ComposerQueuePanel } from "./composer-queue-panel"
import { ComposerUsage } from "./composer-usage"
import type { CatalogModel, ModelSelection } from "./model-catalog"
import type { ComposerUsageMetrics } from "./usage-metrics"
import { ProviderConnectButton } from "./provider-connect"
import { ModelControl } from "./model-control"
import { SkillAutocomplete, type SkillAutocompleteHandle } from "./skill-autocomplete"
import { playSoundEffect } from "../sound-effects/sound-effects"
import "./composer.css"

export type ComposerProps = {
  client: Pick<DesktopClient, "app" | "auth" | "global" | "instance" | "provider" | "session">
  queryClient: QueryClient
  directory: string
  requestDirectory?: string
  sessionID: string
  agents: readonly Agent[]
  models: readonly CatalogModel[]
  selectedAgent: string
  selectedModel: ModelSelection
  status: SessionStatus
  requestPending?: boolean
  childSteering?: boolean
  disabled?: boolean
  branchControl?: JSX.Element
  multiAgentControl?: JSX.Element
  goalModeControl?: JSX.Element
  mcpControl?: JSX.Element
  permissionControl?: JSX.Element
  identityLocked?: boolean
  minimal?: boolean
  usage?: ComposerUsageMetrics
  onAgentChange: (name: string) => void
  onModelChange: (model: ModelSelection) => void
  onProviderConnected: (providerID: string) => void | Promise<void>
  queueStore?: ComposerQueueStore
}

const maximumDraftLines = 5

function numericStyle(value: string) {
  return Number.parseFloat(value) || 0
}

function resizeDraft(textarea: HTMLTextAreaElement) {
  textarea.style.height = "auto"
  const contentHeight = textarea.scrollHeight
  if (contentHeight <= 0) return

  const style = window.getComputedStyle(textarea)
  const lineHeight = numericStyle(style.lineHeight) || 24
  const verticalChrome =
    numericStyle(style.paddingTop) +
    numericStyle(style.paddingBottom) +
    numericStyle(style.borderTopWidth) +
    numericStyle(style.borderBottomWidth)
  const maximumHeight = lineHeight * maximumDraftLines + verticalChrome
  textarea.style.height = `${Math.min(contentHeight, maximumHeight)}px`
  textarea.style.overflowY = contentHeight > maximumHeight ? "auto" : "hidden"
}

function readAttachment(file: globalThis.File): Promise<ComposerAttachment> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onerror = () => reject(reader.error ?? new Error(`Unable to read ${file.name}`))
    reader.onload = () =>
      resolve({
        type: "file",
        mime: file.type || "application/octet-stream",
        filename: file.name,
        url: String(reader.result),
      })
    reader.readAsDataURL(file)
  })
}

const fileMimeTypes: Record<string, string> = {
  bmp: "image/bmp",
  csv: "text/csv",
  gif: "image/gif",
  html: "text/html",
  jpeg: "image/jpeg",
  jpg: "image/jpeg",
  json: "application/json",
  md: "text/markdown",
  pdf: "application/pdf",
  png: "image/png",
  svg: "image/svg+xml",
  txt: "text/plain",
  webp: "image/webp",
  xml: "application/xml",
  zip: "application/zip",
}

export function attachmentFromPath(filePath: string): ComposerAttachment {
  const normalized = filePath.replaceAll("\\", "/")
  const filename = normalized.split("/").at(-1) || normalized
  const extension = filename.includes(".") ? filename.split(".").at(-1)!.toLowerCase() : ""
  const encoded = normalized
    .split("/")
    .map((part, index) => (index === 0 && /^[A-Za-z]:$/u.test(part) ? part : encodeURIComponent(part)))
    .join("/")
  return {
    type: "file",
    mime: fileMimeTypes[extension] ?? "application/octet-stream",
    filename,
    url: normalized.startsWith("//")
      ? `file://${encoded.slice(2)}`
      : normalized.startsWith("/")
        ? `file://${encoded}`
        : `file:///${encoded}`,
  }
}

export function Composer(props: ComposerProps) {
  const controller = createComposerController({
    client: props.client,
    directory: () => props.directory,
    requestDirectory: () => props.requestDirectory ?? props.directory,
    sessionID: () => props.sessionID,
    agent: () => props.selectedAgent,
    model: () => props.selectedModel,
  })
  const queue = createComposerQueue({
    directory: props.directory,
    sessionID: props.sessionID,
    store: props.queueStore,
  })
  const [queuePhase, setQueuePhase] = createSignal<"ready" | "awaiting-busy" | "busy-observed">("ready")
  const [guiding, setGuiding] = createSignal(false)
  const [confirmingTerminate, setConfirmingTerminate] = createSignal(false)
  let confirmTerminateTimer: ReturnType<typeof setTimeout> | undefined
  const [focused, setFocused] = createSignal(false)
  const [autocompleteDismissed, setAutocompleteDismissed] = createSignal(false)
  const [attachments, setAttachments] = createSignal<readonly ComposerAttachment[]>([])
  const [draggingFiles, setDraggingFiles] = createSignal(false)
  let textarea!: HTMLTextAreaElement
  let fileInput!: HTMLInputElement
  let inputRegion!: HTMLDivElement
  let skillAutocomplete: SkillAutocompleteHandle | undefined
  let composing = false
  const active = () => props.status.type !== "idle" || props.requestPending === true || props.childSteering === true
  const slashQuery = () => /^\/([^\s/]*)$/.exec(controller.draft())?.[1]
  const autocompleteOpen = () => !props.minimal && focused() && !autocompleteDismissed() && slashQuery() !== undefined

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
        const bounds = inputRegion.getBoundingClientRect()
        const inside = x >= bounds.left && x <= bounds.right && y >= bounds.top && y <= bounds.bottom
        if (payload.type !== "drop") {
          setDraggingFiles(inside)
          return
        }
        setDraggingFiles(false)
        if (!inside || payload.paths.length === 0) return
        setAttachments((current) => [...current, ...payload.paths.map(attachmentFromPath)])
      })
      if (disposed) unlisten()
    })
    onCleanup(() => {
      disposed = true
      unlisten?.()
    })
  })

  createEffect(() => {
    controller.draft()
    queueMicrotask(() => resizeDraft(textarea))
  })

  createEffect(() => {
    const isActive = active()
    const phase = queuePhase()
    const items = queue.items()

    if (guiding()) return
    if (phase === "awaiting-busy") {
      if (isActive) setQueuePhase("busy-observed")
      return
    }
    if (phase === "busy-observed") {
      if (!isActive) setQueuePhase("ready")
      return
    }
    if (props.disabled || isActive || controller.sending() || controller.failure() || items.length === 0) return

    const item = queue.shift()
    if (!item) return
    const sentAt = Date.now()
    setQueuePhase("awaiting-busy")
    void controller
      .send(item.text, { agent: item.agent, model: item.model }, item.attachments)
      .then(() => refreshConversationIfMissing(sentAt))
      .catch(() => {
        setQueuePhase("ready")
      })
  })

  function enqueueDraft() {
    const text = controller.draft()
    const files = attachments()
    if (!text.trim() && files.length === 0) return
    queue.enqueue({ text, agent: props.selectedAgent, model: props.selectedModel, attachments: files })
    controller.setDraft("")
    setAttachments([])
    playSoundEffect("queue-add")
  }

  async function submit() {
    if (props.disabled) return
    const sendingContent = Boolean(controller.draft().trim() || attachments().length > 0)
    // Minimal child composers have no queue UI, so steering always sends directly.
    if (!props.minimal && (active() || queuePhase() !== "ready" || queue.items().length > 0)) {
      enqueueDraft()
      return
    }
    const files = attachments()
    try {
      const sentAt = Date.now()
      if (props.childSteering && active()) {
        await controller.interruptAndSend(undefined, undefined, files)
        if (sendingContent) playSoundEffect("send")
      } else {
        await controller.send(undefined, undefined, files)
        if (sendingContent) playSoundEffect("send")
      }
      refreshConversationIfMissing(sentAt)
      setAttachments([])
    } catch {
      playSoundEffect("error")
    }
  }

  async function addFiles(files: FileList | readonly globalThis.File[]) {
    const next = await Promise.all(Array.from(files, readAttachment))
    setAttachments((current) => [...current, ...next])
  }

  function stop() {
    void controller.stop().catch(() => {})
  }

  function refreshConversationIfMissing(sentAt: number) {
    const queryKey = keys.messages(props.directory, props.sessionID)
    const snapshot = props.queryClient.getQueryData<ConversationSnapshot>(queryKey)
    const hasRecentUserMessage =
      isConversationSnapshot(snapshot) &&
      snapshot.messages.some(
        (message) => message.info.role === "user" && (message.info.time.created ?? 0) >= Math.max(0, sentAt - 1_000),
      )
    if (hasRecentUserMessage) return
    void props.queryClient.invalidateQueries({
      queryKey,
      exact: true,
    })
  }

  // Two-click terminate: the first click arms the confirmation, the second
  // stops the child assignment and notifies the main agent through the Inbox.
  function terminate() {
    if (props.disabled || controller.terminating()) return
    if (!confirmingTerminate()) {
      setConfirmingTerminate(true)
      clearTimeout(confirmTerminateTimer)
      confirmTerminateTimer = setTimeout(() => setConfirmingTerminate(false), 3000)
      return
    }
    clearTimeout(confirmTerminateTimer)
    setConfirmingTerminate(false)
    void controller
      .terminate()
      .then(() => {
        void props.queryClient.invalidateQueries({ queryKey: keys.sessions(props.directory), exact: true })
        void props.queryClient.invalidateQueries({ queryKey: keys.sessionsAll(props.directory), exact: true })
        void props.queryClient.invalidateQueries({
          queryKey: keys.session(props.directory, props.sessionID),
          exact: true,
        })
        void props.queryClient.invalidateQueries({ queryKey: keys.status(props.directory), exact: true })
        void props.queryClient.invalidateQueries({ queryKey: keys.plansScope(props.directory), exact: false })
      })
      .catch(() => {})
  }

  onCleanup(() => {
    clearTimeout(confirmTerminateTimer)
    queue.dispose({ clear: true })
    void controller.dispose({ cancelSession: true })
  })

  async function guide(id: string) {
    if (guiding() || props.disabled) return
    const item = queue.items().find((entry) => entry.id === id)
    if (!item) return

    setGuiding(true)
    try {
      if (active()) await controller.stop()
      queue.remove(id)
      setQueuePhase("awaiting-busy")
      const sentAt = Date.now()
      await controller.send(item.text, { agent: item.agent, model: item.model }, item.attachments)
      refreshConversationIfMissing(sentAt)
      playSoundEffect("send")
    } catch {
      setQueuePhase("ready")
      // The controller exposes the actionable failure beside the composer.
      playSoundEffect("error")
    } finally {
      setGuiding(false)
    }
  }

  return (
    <div class="composer-stack">
      <Show when={!props.minimal && queue.items().length > 0}>
        <ComposerQueuePanel
          items={queue.items()}
          onGuide={(id) => void guide(id)}
          onMove={queue.move}
          onRemove={queue.remove}
        />
      </Show>
      <BorderBeam
        class="composer__beam"
        colorVariant="jyy"
        theme="light"
        borderRadius={8}
        active={active()}
        strength={1}
        style={
          {
            "--beam-stroke-opacity": 1.5,
            "--beam-inner-opacity": 1.4,
            "--beam-bloom-opacity": 1.5,
          } as JSX.CSSProperties
        }
      >
        <section
          class="composer"
          data-minimal={props.minimal ? "true" : "false"}
          aria-label={tr("composer.message-editor")}
        >
          <Show when={!props.minimal}>
            <div class="composer__selectors">
              <AgentSelect
                agents={props.agents}
                value={props.selectedAgent}
                disabled={props.identityLocked || controller.sending() || props.disabled}
                onChange={props.onAgentChange}
              />
              <ProviderConnectButton
                client={props.client}
                directory={props.directory}
                disabled={controller.sending() || props.disabled}
                onConnected={props.onProviderConnected}
              />
              <ModelControl
                models={props.models}
                value={props.selectedModel}
                disabled={props.identityLocked || controller.sending() || props.disabled}
                onChange={props.onModelChange}
              />
              {props.branchControl}
              {props.multiAgentControl}
              {props.goalModeControl}
              {props.mcpControl}
            </div>
          </Show>

          <div
            ref={inputRegion}
            class="composer__input"
            data-active={active()}
            data-dragging={draggingFiles()}
            onDragEnter={(event) => {
              if (!event.dataTransfer?.types.includes("Files")) return
              event.preventDefault()
              setDraggingFiles(true)
            }}
            onDragOver={(event) => {
              if (!event.dataTransfer?.types.includes("Files")) return
              event.preventDefault()
              event.dataTransfer.dropEffect = "copy"
            }}
            onDragLeave={(event) => {
              if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setDraggingFiles(false)
            }}
            onDrop={(event) => {
              event.preventDefault()
              setDraggingFiles(false)
              if (event.dataTransfer?.files.length) void addFiles(event.dataTransfer.files)
            }}
          >
            <SkillAutocomplete
              client={props.client}
              queryClient={props.queryClient}
              directory={props.directory}
              agent={props.selectedAgent}
              open={autocompleteOpen()}
              query={slashQuery() ?? ""}
              ref={(handle) => {
                skillAutocomplete = handle
              }}
              onDismiss={() => setAutocompleteDismissed(true)}
              onSelect={(name) => {
                controller.setDraft(`/${name} `)
                setAutocompleteDismissed(true)
                queueMicrotask(() => {
                  textarea.focus()
                  textarea.setSelectionRange(textarea.value.length, textarea.value.length)
                  resizeDraft(textarea)
                })
              }}
            />
            <label class="composer__label" for="composer-message">
              {tr("composer.information")}
            </label>
            <input
              ref={fileInput}
              class="composer__file-input"
              type="file"
              multiple
              aria-label={tr("composer.choose-files")}
              onChange={(event) => {
                if (event.currentTarget.files?.length) void addFiles(event.currentTarget.files)
                event.currentTarget.value = ""
              }}
            />
            <Show when={attachments().length > 0}>
              <ul class="composer__attachments" aria-label={tr("composer.attachments")}>
                <For each={attachments()}>
                  {(attachment, index) => (
                    <li>
                      <File aria-hidden="true" />
                      <span title={attachment.filename}>{attachment.filename}</span>
                      <button
                        type="button"
                        aria-label={tr("composer.remove-attachment", { name: attachment.filename })}
                        onClick={() => setAttachments((items) => items.filter((_, itemIndex) => itemIndex !== index()))}
                      >
                        <X aria-hidden="true" />
                      </button>
                    </li>
                  )}
                </For>
              </ul>
            </Show>
            <textarea
              ref={textarea}
              id="composer-message"
              aria-label={tr("composer.information")}
              rows={1}
              value={controller.draft()}
              aria-autocomplete="list"
              aria-expanded={autocompleteOpen()}
              aria-controls={autocompleteOpen() ? "composer-skill-listbox" : undefined}
              disabled={controller.sending()}
              placeholder={tr("composer.send-message-to-agent")}
              onInput={(event) => {
                controller.setDraft(event.currentTarget.value)
                setAutocompleteDismissed(false)
                resizeDraft(event.currentTarget)
              }}
              onFocus={() => {
                setFocused(true)
                setAutocompleteDismissed(false)
              }}
              onBlur={() => setFocused(false)}
              onCompositionStart={() => {
                composing = true
              }}
              onCompositionEnd={() => {
                composing = false
              }}
              onKeyDown={(event) => {
                if (skillAutocomplete?.handleKeyDown(event)) return
                if (event.key !== "Enter" || event.shiftKey || event.isComposing || composing) return
                event.preventDefault()
                submit()
              }}
              onPaste={(event) => {
                const clipboard = event.clipboardData
                if (!clipboard) return
                const files = Array.from(clipboard.items)
                  .filter((item) => item.kind === "file")
                  .map((item) => item.getAsFile())
                  .filter((file): file is globalThis.File => file !== null)
                if (files.length === 0) return
                event.preventDefault()
                const timestamp = new Date().toISOString().replace(/[:.]/gu, "-")
                const renamed = files.map((file, index) => {
                  const extension =
                    (file.name.includes(".") ? file.name.split(".").at(-1) : file.type.split("/").at(-1)) ?? "png"
                  const name =
                    file.name === "" || file.name.startsWith("image")
                      ? `pasted-${timestamp}${index > 0 ? `-${index + 1}` : ""}.${extension}`
                      : file.name
                  return new globalThis.File([file], name, { type: file.type })
                })
                void addFiles(renamed)
              }}
            />
            <Show when={!props.minimal}>
              <button
                type="button"
                class="composer__attach"
                data-sound-effect="attach"
                aria-label={tr("composer.add-attachment")}
                disabled={props.disabled || controller.sending()}
                onClick={() => fileInput.click()}
              >
                <Plus aria-hidden="true" />
              </button>
            </Show>
            <div class="composer__action">
              <Show
                when={active()}
                fallback={
                  <IconButton
                    data-sound-effect="none"
                    label={controller.sending() ? tr("composer.sending") : tr("composer.send")}
                    disabled={props.disabled || (!controller.draft().trim() && attachments().length === 0)}
                    loading={controller.sending()}
                    loadingLabel={tr("composer.sending")}
                    onClick={submit}
                  >
                    <Send aria-hidden="true" />
                  </IconButton>
                }
              >
                <Show
                  when={props.minimal && props.childSteering}
                  fallback={
                    <div class="composer__active-actions">
                      <Show when={!props.minimal}>
                        <IconButton
                          data-sound-effect="none"
                          label={tr("composer.join-queue")}
                          disabled={!controller.draft().trim() && attachments().length === 0}
                          onClick={submit}
                        >
                          <ListPlus aria-hidden="true" />
                        </IconButton>
                      </Show>
                      <Button
                        data-sound-effect="stop"
                        size="small"
                        variant="secondary"
                        loading={controller.stopping()}
                        loadingLabel={tr("composer.stopping")}
                        onClick={stop}
                      >
                        <Square aria-hidden="true" />
                        {tr("composer.stop")}
                      </Button>
                    </div>
                  }
                >
                  <div class="composer__active-actions">
                    <span class="composer__steering-warning">{tr("composer.interrupt-assignment-warning")}</span>
                    <Button
                      data-sound-effect="none"
                      size="small"
                      variant="secondary"
                      disabled={props.disabled || (!controller.draft().trim() && attachments().length === 0)}
                      loading={controller.sending()}
                      loadingLabel={tr("composer.sending")}
                      onClick={submit}
                    >
                      <Send aria-hidden="true" />
                      {tr("composer.send-and-interrupt")}
                    </Button>
                    <Button
                      size="small"
                      variant="secondary"
                      disabled={props.disabled || controller.sending()}
                      loading={controller.terminating()}
                      loadingLabel={tr("composer.terminating")}
                      data-confirming={confirmingTerminate() ? "true" : undefined}
                      onClick={terminate}
                    >
                      <OctagonX aria-hidden="true" />
                      {confirmingTerminate() ? tr("composer.terminate-confirm") : tr("composer.terminate")}
                    </Button>
                  </div>
                </Show>
              </Show>
            </div>
          </div>

          <Show when={props.usage}>
            <ComposerUsage metrics={props.usage!} permissionControl={props.permissionControl} />
          </Show>

          <Show when={!props.minimal ? controller.failure() : undefined} keyed>
            {(failure) => (
              <div class="composer__failure">
                <InlineError message={errorMessage(failure, tr("composer.message-sending-failed"))} />
                <Show when={controller.lastFailedDraft() !== undefined}>
                  <Button size="small" variant="secondary" onClick={() => void controller.retry().catch(() => {})}>
                    <RotateCcw aria-hidden="true" />
                    {tr("changes.try-again")}
                  </Button>
                </Show>
              </div>
            )}
          </Show>
        </section>
      </BorderBeam>
    </div>
  )
}
