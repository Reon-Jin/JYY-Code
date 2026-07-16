import { tr } from "../../i18n/i18n-context"
import type { Agent, SessionStatus } from "@jyycode-ai/sdk/v2/client"
import type { QueryClient } from "@tanstack/solid-query"
import { File, ListPlus, Plus, RotateCcw, Send, Square, X } from "lucide-solid"
import { createEffect, createSignal, For, onCleanup, onMount, Show, type JSX } from "solid-js"
import { Button, IconButton } from "../../components/ui/button"
import { InlineError } from "../../components/ui/inline-error"
import type { DesktopClient } from "../../data/sdk"
import { ClusterModelControl } from "../multi-agent/cluster-model-control"
import { errorMessage } from "../projects/project-controller"
import { AgentSelect } from "./agent-select"
import { createComposerController, type ComposerAttachment } from "./composer-controller"
import { createComposerQueue, type ComposerQueueStore } from "./composer-queue"
import { ComposerQueuePanel } from "./composer-queue-panel"
import { ComposerUsage } from "./composer-usage"
import type { CatalogModel, ModelSelection } from "./model-catalog"
import type { ComposerUsageMetrics } from "./usage-metrics"
import { ProviderConnectButton } from "./provider-connect"
import { SkillAutocomplete, type SkillAutocompleteHandle } from "./skill-autocomplete"
import "./composer.css"

export type ComposerProps = {
  client: Pick<DesktopClient, "app" | "auth" | "global" | "instance" | "provider" | "session">
  queryClient: QueryClient
  directory: string
  sessionID: string
  agents: readonly Agent[]
  models: readonly CatalogModel[]
  selectedAgent: string
  selectedModel: ModelSelection
  agentClusterEnabled: boolean
  status: SessionStatus
  requestPending?: boolean
  disabled?: boolean
  branchControl?: JSX.Element
  multiAgentControl?: JSX.Element
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
    .map((part, index) => index === 0 && /^[A-Za-z]:$/u.test(part) ? part : encodeURIComponent(part))
    .join("/")
  return {
    type: "file",
    mime: fileMimeTypes[extension] ?? "application/octet-stream",
    filename,
    url: normalized.startsWith("//") ? `file://${encoded.slice(2)}` : normalized.startsWith("/") ? `file://${encoded}` : `file:///${encoded}`,
  }
}

export function Composer(props: ComposerProps) {
  const controller = createComposerController({
    client: props.client,
    directory: () => props.directory,
    sessionID: () => props.sessionID,
    agent: () => props.selectedAgent,
    model: () => props.selectedModel,
    agentClusterEnabled: () => props.agentClusterEnabled,
  })
  const queue = createComposerQueue({
    directory: props.directory,
    sessionID: props.sessionID,
    store: props.queueStore,
  })
  const [queuePhase, setQueuePhase] = createSignal<"ready" | "awaiting-busy" | "busy-observed">("ready")
  const [guiding, setGuiding] = createSignal(false)
  const [focused, setFocused] = createSignal(false)
  const [autocompleteDismissed, setAutocompleteDismissed] = createSignal(false)
  const [attachments, setAttachments] = createSignal<readonly ComposerAttachment[]>([])
  const [draggingFiles, setDraggingFiles] = createSignal(false)
  let textarea!: HTMLTextAreaElement
  let fileInput!: HTMLInputElement
  let inputRegion!: HTMLDivElement
  let skillAutocomplete: SkillAutocompleteHandle | undefined
  let composing = false
  const active = () => props.status.type !== "idle" || props.requestPending === true
  const slashQuery = () => /^\/([^\s/]*)$/.exec(controller.draft())?.[1]
  const autocompleteOpen = () =>
    !props.minimal && focused() && !autocompleteDismissed() && slashQuery() !== undefined

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
        queueMicrotask(() => textarea.focus())
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
    setQueuePhase("awaiting-busy")
    void controller.send(item.text, { agent: item.agent, model: item.model }, item.attachments).catch(() => {
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
  }

  async function submit() {
    if (props.disabled) return
    if (active() || queuePhase() !== "ready" || queue.items().length > 0) {
      enqueueDraft()
      return
    }
    const files = attachments()
    try {
      await controller.send(undefined, undefined, files)
      setAttachments([])
    } catch {}
  }

  async function addFiles(files: FileList | readonly globalThis.File[]) {
    const next = await Promise.all(Array.from(files, readAttachment))
    setAttachments((current) => [...current, ...next])
  }

  function stop() {
    void controller.stop().catch(() => {})
  }

  async function guide(id: string) {
    if (guiding() || props.disabled) return
    const item = queue.items().find((entry) => entry.id === id)
    if (!item) return

    setGuiding(true)
    try {
      if (active()) await controller.stop()
      queue.remove(id)
      setQueuePhase("awaiting-busy")
      await controller.send(item.text, { agent: item.agent, model: item.model }, item.attachments)
    } catch {
      setQueuePhase("ready")
      // The controller exposes the actionable failure beside the composer.
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
      <section class="composer" data-minimal={props.minimal ? "true" : "false"} aria-label={tr("composer.message-editor")}>
        <Show when={!props.minimal}>
          <div class="composer__selectors">
          <AgentSelect
            agents={props.agents}
            value={props.selectedAgent}
            disabled={props.identityLocked || controller.sending() || active()}
            onChange={props.onAgentChange}
          />
          <ProviderConnectButton
            client={props.client}
            directory={props.directory}
            disabled={controller.sending() || active() || props.disabled}
            onConnected={props.onProviderConnected}
          />
          <ClusterModelControl
            client={props.client}
            queryClient={props.queryClient}
            models={props.models}
            currentModel={props.selectedModel}
            disabled={props.identityLocked || controller.sending() || active()}
            identityLocked={props.identityLocked}
            onModelChange={props.onModelChange}
          />
          {props.branchControl}
          {props.multiAgentControl}
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
          />
          <Show when={!props.minimal}>
            <button
              type="button"
              class="composer__attach"
              aria-label={tr("composer.add-attachment")}
              disabled={props.disabled || controller.sending()}
              onClick={() => fileInput.click()}
            >
              <Plus aria-hidden="true" />
            </button>
          </Show>
          <Show when={!props.minimal}>
            <div class="composer__action">
            <Show
              when={active()}
              fallback={
                <IconButton
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
              <div class="composer__active-actions">
                <IconButton label={tr("composer.join-queue")} disabled={!controller.draft().trim() && attachments().length === 0} onClick={submit}>
                  <ListPlus aria-hidden="true" />
                </IconButton>
                <Button
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
            </Show>
            </div>
          </Show>
        </div>

        <Show when={props.usage} keyed>
          {(usage) => <ComposerUsage metrics={usage} permissionControl={props.permissionControl} />}
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
    </div>
  )
}
