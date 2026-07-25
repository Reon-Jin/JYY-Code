import { tr } from "../../i18n/i18n-context"
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
    <section class="request-panel" aria-label={tr("requests.permission-request")} role="region">
      <p class="request-panel__announcement" role="status" aria-live="polite">
        {tr("requests.agent-sent-a-new-permission-request")}
      </p>
      <header class="request-panel__header">
        <span class="request-panel__icon" aria-hidden="true">
          <ShieldAlert />
        </span>
        <span class="request-panel__heading">
          <strong>{tr("requests.permission-request")}</strong>
          <small>{props.request.permission}</small>
        </span>
        <Button size="small" variant="ghost" disabled={disabled()} onClick={() => focusTarget?.focus()}>
          {tr("requests.handle-request")}
        </Button>
      </header>

      <div class="request-panel__body">
        <Show when={view() === "request"}>
          <p>{tr("requests.the-agent-wants-to-do-the-following")}</p>
          <ul class="request-patterns">
            <For each={props.request.patterns}>
              {(pattern) => (
                <li>
                  <code>{pattern}</code>
                </li>
              )}
            </For>
          </ul>
          <div class="request-panel__actions">
            <Button
              ref={(element) => {
                focusTarget = element
              }}
              size="small"
              disabled={disabled()}
              loading={submitting()}
              loadingLabel={tr("requests.submitting")}
              onClick={() => void reply("once")}
            >
              {tr("requests.only-allowed-this-time")}
            </Button>
            <Button size="small" variant="secondary" disabled={disabled()} onClick={() => show("always")}>
              {tr("requests.always-allowed")}
            </Button>
            <Button size="small" variant="ghost" disabled={disabled()} onClick={() => show("reject")}>
              {tr("requests.reject")}
            </Button>
          </div>
        </Show>

        <Show when={view() === "always"}>
          <p>{tr("requests.once-confirmed-the-following-modes-will-continue-to")}</p>
          <ul class="request-patterns">
            <For each={alwaysPatterns()}>
              {(pattern) => (
                <li>
                  <code>{pattern}</code>
                </li>
              )}
            </For>
          </ul>
          <div class="request-panel__actions">
            <Button
              ref={(element) => {
                focusTarget = element
              }}
              size="small"
              disabled={disabled()}
              loading={submitting()}
              loadingLabel={tr("requests.submitting")}
              onClick={() => void reply("always")}
            >
              {tr("requests.confirm-always-allow")}
            </Button>
            <Button size="small" variant="ghost" disabled={disabled()} onClick={() => show("request")}>
              {tr("github.cancel")}
            </Button>
          </div>
        </Show>

        <Show when={view() === "reject"}>
          <label class="request-panel__field">
            <span>{tr("requests.reason-for-rejection-optional")}</span>
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
              loadingLabel={tr("requests.rejecting")}
              onClick={() => void reply("reject")}
            >
              {tr("requests.confirm-rejection")}
            </Button>
            <Button size="small" variant="ghost" disabled={disabled()} onClick={() => show("request")}>
              {tr("github.cancel")}
            </Button>
          </div>
        </Show>

        <Show when={failure()}>
          {(cause) => <InlineError message={errorMessage(cause(), tr("requests.permission-reply-failed"))} />}
        </Show>
        <p
          class="request-panel__status"
          role="status"
          aria-label={tr("requests.permission-request-status")}
          aria-live="polite"
        >
          {submitted() ? tr("requests.submitted-waiting-for-confirmation-from-the-server") : ""}
        </p>
      </div>
    </section>
  )
}
