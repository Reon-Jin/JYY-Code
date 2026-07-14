import type { Agent, SessionStatus } from "@jyycode-ai/sdk/v2/client"
import { ListPlus, RotateCcw, Send, Square } from "lucide-solid"
import { createEffect, createMemo, createSignal, Show, type JSX } from "solid-js"
import { Button, IconButton } from "../../components/ui/button"
import { InlineError } from "../../components/ui/inline-error"
import type { DesktopClient } from "../../data/sdk"
import { errorMessage } from "../projects/project-controller"
import { AgentSelect } from "./agent-select"
import { createComposerController } from "./composer-controller"
import { createComposerQueue, type ComposerQueueStore } from "./composer-queue"
import { ComposerQueuePanel } from "./composer-queue-panel"
import type { CatalogModel, ModelSelection } from "./model-catalog"
import { ModelSelect } from "./model-select"
import { ProviderConnectButton } from "./provider-connect"
import "./composer.css"

export type ComposerProps = {
  client: Pick<DesktopClient, "auth" | "instance" | "provider" | "session">
  directory: string
  sessionID: string
  agents: readonly Agent[]
  models: readonly CatalogModel[]
  selectedAgent: string
  selectedModel: ModelSelection
  status: SessionStatus
  lastMessageError?: { name: string }
  disabled?: boolean
  branchControl?: JSX.Element
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
  })
  const queue = createComposerQueue({
    directory: props.directory,
    sessionID: props.sessionID,
    store: props.queueStore,
  })
  const [queuePhase, setQueuePhase] = createSignal<"ready" | "awaiting-busy" | "busy-observed">("ready")
  let textarea!: HTMLTextAreaElement
  let composing = false
  const active = () => props.status.type !== "idle"
  const generationStatus = createMemo(() => {
    if (controller.stopping()) return "正在停止生成"
    if (controller.sending()) return "正在发送消息"
    if (props.status.type === "retry") return `Agent 正在重试（第 ${props.status.attempt} 次）`
    if (props.status.type === "busy") return "Agent 正在生成回复"
    if (props.lastMessageError?.name === "MessageAbortedError") return "已停止生成"
    if (props.disabled) return "后端连接中断，消息已暂存，恢复连接后可发送"
    return ""
  })

  createEffect(() => {
    controller.draft()
    queueMicrotask(() => resizeDraft(textarea))
  })

  createEffect(() => {
    const isActive = active()
    const phase = queuePhase()
    const items = queue.items()

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

  return (
    <div class="composer-stack">
      <Show when={queue.items().length > 0}>
        <ComposerQueuePanel items={queue.items()} onRemove={queue.remove} />
      </Show>
      <section class="composer" aria-label="消息编辑器">
        <div class="composer__selectors">
          <AgentSelect
            agents={props.agents}
            value={props.selectedAgent}
            disabled={controller.sending() || active()}
            onChange={props.onAgentChange}
          />
          <ProviderConnectButton
            client={props.client}
            directory={props.directory}
            disabled={controller.sending() || active() || props.disabled}
            onConnected={props.onProviderConnected}
          />
          <ModelSelect
            models={props.models}
            value={props.selectedModel}
            disabled={controller.sending() || active()}
            onChange={props.onModelChange}
          />
          {props.branchControl}
        </div>

        <div class="composer__input" data-active={active()}>
          <label class="composer__label" for="composer-message">
            消息
          </label>
          <textarea
            ref={textarea}
            id="composer-message"
            aria-label="消息"
            rows={1}
            value={controller.draft()}
            disabled={controller.sending()}
            placeholder="向 Agent 发送消息"
            onInput={(event) => {
              controller.setDraft(event.currentTarget.value)
              resizeDraft(event.currentTarget)
            }}
            onCompositionStart={() => {
              composing = true
            }}
            onCompositionEnd={() => {
              composing = false
            }}
            onKeyDown={(event) => {
              if (event.key !== "Enter" || event.shiftKey || event.isComposing || composing) return
              event.preventDefault()
              submit()
            }}
          />
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
        </div>

        <div class="composer__feedback">
          <p class="composer__status" role="status" aria-live="polite">
            {generationStatus()}
          </p>
          <Show when={controller.failure()}>
            {(failure) => (
              <div class="composer__failure">
                <InlineError message={errorMessage(failure(), "消息发送失败")} />
                <Show when={controller.lastFailedDraft() !== undefined}>
                  <Button size="small" variant="secondary" onClick={() => void controller.retry().catch(() => {})}>
                    <RotateCcw aria-hidden="true" />
                    重试
                  </Button>
                </Show>
              </div>
            )}
          </Show>
        </div>
      </section>
    </div>
  )
}
