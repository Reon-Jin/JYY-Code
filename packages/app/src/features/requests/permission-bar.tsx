import type { PermissionRequest } from "@jyycode-ai/sdk/v2/client"
import { ShieldAlert } from "lucide-solid"
import { createMemo, createSignal, For, Show } from "solid-js"
import { Button } from "../../components/ui/button"
import { InlineError } from "../../components/ui/inline-error"
import type { DesktopClient } from "../../data/sdk"
import { errorMessage } from "../projects/project-controller"
import "./requests.css"

export type PermissionBarProps = {
  client: Pick<DesktopClient, "permission">
  directory: string
  request: PermissionRequest
}

type PermissionView = "request" | "always" | "reject"

export function PermissionBar(props: PermissionBarProps) {
  const [view, setView] = createSignal<PermissionView>("request")
  const [reason, setReason] = createSignal("")
  const [submitting, setSubmitting] = createSignal(false)
  const [submitted, setSubmitted] = createSignal(false)
  const [failure, setFailure] = createSignal<unknown>()
  const disabled = () => submitting() || submitted()
  const alwaysPatterns = createMemo(() => (props.request.always.length ? props.request.always : props.request.patterns))
  let focusTarget: HTMLElement | undefined

  function show(viewName: PermissionView) {
    setFailure(undefined)
    setView(viewName)
  }

  async function reply(response: "once" | "always" | "reject") {
    if (disabled()) return
    setSubmitting(true)
    setFailure(undefined)
    try {
      const message = response === "reject" ? reason().trim() : ""
      await props.client.permission.reply(
        {
          directory: props.directory,
          requestID: props.request.id,
          reply: response,
          ...(message ? { message } : {}),
        },
        { throwOnError: true },
      )
      setSubmitted(true)
    } catch (cause) {
      setFailure(cause)
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <section class="request-panel" aria-label="权限请求" role="region">
      <p class="request-panel__announcement" role="status" aria-live="polite">
        Agent 发来了新的权限请求
      </p>
      <header class="request-panel__header">
        <span class="request-panel__icon" aria-hidden="true">
          <ShieldAlert />
        </span>
        <span class="request-panel__heading">
          <strong>权限请求</strong>
          <small>{props.request.permission}</small>
        </span>
        <Button size="small" variant="ghost" disabled={disabled()} onClick={() => focusTarget?.focus()}>
          处理请求
        </Button>
      </header>

      <div class="request-panel__body">
        <Show when={view() === "request"}>
          <p>Agent 希望执行以下操作：</p>
          <ul class="request-patterns">
            <For each={props.request.patterns}>{(pattern) => <li><code>{pattern}</code></li>}</For>
          </ul>
          <div class="request-panel__actions">
            <Button
              ref={(element) => {
                focusTarget = element
              }}
              size="small"
              disabled={disabled()}
              loading={submitting()}
              loadingLabel="正在提交"
              onClick={() => void reply("once")}
            >
              仅本次允许
            </Button>
            <Button size="small" variant="secondary" disabled={disabled()} onClick={() => show("always")}>
              始终允许
            </Button>
            <Button size="small" variant="ghost" disabled={disabled()} onClick={() => show("reject")}>
              拒绝
            </Button>
          </div>
        </Show>

        <Show when={view() === "always"}>
          <p>确认后，以下模式将持续获得允许：</p>
          <ul class="request-patterns">
            <For each={alwaysPatterns()}>{(pattern) => <li><code>{pattern}</code></li>}</For>
          </ul>
          <div class="request-panel__actions">
            <Button
              ref={(element) => {
                focusTarget = element
              }}
              size="small"
              disabled={disabled()}
              loading={submitting()}
              loadingLabel="正在提交"
              onClick={() => void reply("always")}
            >
              确认始终允许
            </Button>
            <Button size="small" variant="ghost" disabled={disabled()} onClick={() => show("request")}>
              取消
            </Button>
          </div>
        </Show>

        <Show when={view() === "reject"}>
          <label class="request-panel__field">
            <span>拒绝原因（可选）</span>
            <textarea
              ref={(element) => {
                focusTarget = element
              }}
              rows={2}
              value={reason()}
              disabled={disabled()}
              onInput={(event) => setReason(event.currentTarget.value)}
            />
          </label>
          <div class="request-panel__actions">
            <Button
              size="small"
              variant="danger"
              disabled={disabled()}
              loading={submitting()}
              loadingLabel="正在拒绝"
              onClick={() => void reply("reject")}
            >
              确认拒绝
            </Button>
            <Button size="small" variant="ghost" disabled={disabled()} onClick={() => show("request")}>
              取消
            </Button>
          </div>
        </Show>

        <Show when={failure()}>{(cause) => <InlineError message={errorMessage(cause(), "权限回复失败")} />}</Show>
        <p class="request-panel__status" role="status" aria-label="权限请求状态" aria-live="polite">
          {submitted() ? "已提交，等待服务端确认" : ""}
        </p>
      </div>
    </section>
  )
}
