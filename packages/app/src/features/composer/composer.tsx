import type { Agent, SessionStatus } from "@jyycode-ai/sdk/v2/client"
import { RotateCcw, Send, Square } from "lucide-solid"
import { createEffect, createMemo, Show } from "solid-js"
import { Button, IconButton } from "../../components/ui/button"
import { InlineError } from "../../components/ui/inline-error"
import type { DesktopClient } from "../../data/sdk"
import { errorMessage } from "../projects/project-controller"
import { AgentSelect } from "./agent-select"
import { createComposerController } from "./composer-controller"
import type { CatalogModel, ModelSelection } from "./model-catalog"
import { ModelSelect } from "./model-select"
import "./composer.css"

export type ComposerProps = {
  client: Pick<DesktopClient, "session">
  directory: string
  sessionID: string
  agents: readonly Agent[]
  models: readonly CatalogModel[]
  selectedAgent: string
  selectedModel: ModelSelection
  status: SessionStatus
  lastMessageError?: { name: string }
  disabled?: boolean
  onAgentChange: (name: string) => void
  onModelChange: (model: ModelSelection) => void
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

  function submit() {
    if (props.disabled) return
    void controller.send().catch(() => {})
  }

  function stop() {
    void controller.stop().catch(() => {})
  }

  return (
    <section class="composer" aria-label="消息编辑器">
      <div class="composer__selectors">
        <AgentSelect
          agents={props.agents}
          value={props.selectedAgent}
          disabled={controller.sending() || active()}
          onChange={props.onAgentChange}
        />
        <ModelSelect
          models={props.models}
          value={props.selectedModel}
          disabled={controller.sending() || active()}
          onChange={props.onModelChange}
        />
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
  )
}
