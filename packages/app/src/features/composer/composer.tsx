import type { Agent, SessionStatus } from "@jyycode-ai/sdk/v2/client"
import type { QueryClient } from "@tanstack/solid-query"
import { ListPlus, RotateCcw, Send, Square } from "lucide-solid"
import { createEffect, createSignal, Show, type JSX } from "solid-js"
import { Button, IconButton } from "../../components/ui/button"
import { InlineError } from "../../components/ui/inline-error"
import type { DesktopClient } from "../../data/sdk"
import { ClusterModelControl } from "../multi-agent/cluster-model-control"
import { errorMessage } from "../projects/project-controller"
import { AgentSelect } from "./agent-select"
import { createComposerController } from "./composer-controller"
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
  let textarea!: HTMLTextAreaElement
  let skillAutocomplete: SkillAutocompleteHandle | undefined
  let composing = false
  const active = () => props.status.type !== "idle" || props.requestPending === true
  const slashQuery = () => /^\/([^\s/]*)$/.exec(controller.draft())?.[1]
  const autocompleteOpen = () =>
    !props.minimal && focused() && !autocompleteDismissed() && slashQuery() !== undefined
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
    void controller.send(item.text, { agent: item.agent, model: item.model }).catch(() => {
      setQueuePhase("ready")
    })
  })

  function enqueueDraft() {
    const text = controller.draft()
    if (!text.trim()) return
    queue.enqueue({ text, agent: props.selectedAgent, model: props.selectedModel })
    controller.setDraft("")
  }

  function submit() {
    if (props.disabled) return
    if (active() || queuePhase() !== "ready" || queue.items().length > 0) {
      enqueueDraft()
      return
    }
    void controller.send().catch(() => {})
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
      await controller.send(item.text, { agent: item.agent, model: item.model })
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
      <section class="composer" data-minimal={props.minimal ? "true" : "false"} aria-label="消息编辑器">
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

        <div class="composer__input" data-active={active()}>
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
            消息
          </label>
          <textarea
            ref={textarea}
            id="composer-message"
            aria-label="消息"
            rows={1}
            value={controller.draft()}
            aria-autocomplete="list"
            aria-expanded={autocompleteOpen()}
            aria-controls={autocompleteOpen() ? "composer-skill-listbox" : undefined}
            disabled={controller.sending()}
            placeholder="向智能体发送消息"
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
            <div class="composer__action">
            <Show
              when={active()}
              fallback={
                <IconButton
                  label={controller.sending() ? "正在发送" : "发送"}
                  disabled={props.disabled || !controller.draft().trim()}
                  loading={controller.sending()}
                  loadingLabel="正在发送"
                  onClick={submit}
                >
                  <Send aria-hidden="true" />
                </IconButton>
              }
            >
              <div class="composer__active-actions">
                <IconButton label="加入队列" disabled={!controller.draft().trim()} onClick={submit}>
                  <ListPlus aria-hidden="true" />
                </IconButton>
                <Button
                  size="small"
                  variant="secondary"
                  loading={controller.stopping()}
                  loadingLabel="正在停止"
                  onClick={stop}
                >
                  <Square aria-hidden="true" />
                  停止
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
              <InlineError message={errorMessage(failure, "消息发送失败")} />
              <Show when={controller.lastFailedDraft() !== undefined}>
                <Button size="small" variant="secondary" onClick={() => void controller.retry().catch(() => {})}>
                  <RotateCcw aria-hidden="true" />
                  重试
                </Button>
              </Show>
            </div>
          )}
        </Show>
      </section>
    </div>
  )
}
