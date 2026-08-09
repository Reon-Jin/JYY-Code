import { tr } from "../../i18n/i18n-context"
import type { Session, SessionStatus } from "@jyycode-ai/sdk/v2/client"
import { A } from "@solidjs/router"
import { Circle, Clock3 } from "lucide-solid"
import { createEffect, createSignal, Show } from "solid-js"
import { Button } from "../../components/ui/button"
import { InlineError } from "../../components/ui/inline-error"
import { errorMessage } from "../projects/project-controller"
import { SessionActions } from "./session-actions"

export function relativeSessionTime(created: number, now = Date.now()) {
  const elapsed = Math.max(0, now - created)
  const minutes = Math.floor(elapsed / 60_000)
  if (minutes < 1) return tr("git.just")
  if (minutes < 60) return tr("time.minutes-ago", { count: minutes })
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return tr("time.hours-ago", { count: hours })
  const days = Math.floor(hours / 24)
  if (days < 7) return tr("time.days-ago", { count: days })
  return new Intl.DateTimeFormat("zh-CN", { month: "short", day: "numeric" }).format(created)
}

function statusText(status: SessionStatus | undefined) {
  switch (status?.type) {
    case "busy":
      return tr("sessions.generating")
    case "retry":
      return tr("sessions.waiting-for-retry")
    default:
      return tr("sessions.idle")
  }
}

export type SessionListItemProps = {
  session: Session
  status?: SessionStatus
  active: boolean
  archived: boolean
  now: number
  disabled?: boolean
  onNavigate?: () => void
  onRename: (sessionID: string, title: string) => Promise<void>
  onArchive: (sessionID: string) => Promise<void>
  onDelete: (sessionID: string) => Promise<void>
}

export function SessionListItem(props: SessionListItemProps) {
  const [editing, setEditing] = createSignal(false)
  const [title, setTitle] = createSignal(props.session.title)
  const [saving, setSaving] = createSignal(false)
  const [error, setError] = createSignal<string>()
  let input: HTMLInputElement | undefined

  createEffect(() => {
    if (!editing()) setTitle(props.session.title)
  })

  function beginRename() {
    setTitle(props.session.title)
    setError(undefined)
    setEditing(true)
    queueMicrotask(() => {
      input?.focus()
      input?.select()
    })
  }

  async function save(event: SubmitEvent) {
    event.preventDefault()
    const nextTitle = title().trim()
    if (!nextTitle) {
      setError(tr("sessions.name-cannot-be-empty"))
      input?.focus()
      return
    }

    setSaving(true)
    setError(undefined)
    try {
      await props.onRename(props.session.id, nextTitle)
      setEditing(false)
    } catch (cause) {
      setError(errorMessage(cause, tr("sessions.unable-to-rename-session")))
    } finally {
      setSaving(false)
    }
  }

  return (
    <li class="session-list-item" data-active={props.active ? "true" : undefined}>
      <Show
        when={!editing()}
        fallback={
          <form class="session-rename" onSubmit={save}>
            <label class="session-rename__label" for={`rename-${props.session.id}`}>
              {tr("sessions.rename")} {props.session.title}
            </label>
            <input
              ref={input}
              id={`rename-${props.session.id}`}
              value={title()}
              disabled={saving()}
              onInput={(event) => setTitle(event.currentTarget.value)}
              onKeyDown={(event) => {
                if (event.key !== "Escape") return
                event.preventDefault()
                setEditing(false)
                setError(undefined)
              }}
            />
            <div class="session-rename__actions">
              <Button type="submit" size="small" loading={saving()} loadingLabel={tr("mcp.saving")}>
                {tr("sessions.save-name")}
              </Button>
              <Button
                size="small"
                variant="ghost"
                disabled={saving()}
                onClick={() => {
                  setEditing(false)
                  setError(undefined)
                }}
              >
                {tr("github.cancel")}
              </Button>
            </div>
            <Show when={error()}>{(message) => <InlineError message={message()} />}</Show>
          </form>
        }
      >
        <A
          class="session-list-item__link"
          href={`/session/${encodeURIComponent(props.session.id)}`}
          aria-current={props.active ? "page" : undefined}
          onClick={props.onNavigate}
        >
          <span class="session-list-item__title">{props.session.title}</span>
          <span class="session-list-item__meta">
            <span class="session-list-item__status" data-status={props.status?.type ?? "idle"}>
              <Circle aria-hidden="true" />
              {statusText(props.status)}
            </span>
            <span>
              <Clock3 aria-hidden="true" />
              {relativeSessionTime(props.session.time.created, props.now)}
            </span>
          </span>
        </A>
        <SessionActions
          session={props.session}
          archived={props.archived}
          disabled={props.disabled}
          onRename={beginRename}
          onArchive={() => props.onArchive(props.session.id)}
          onDelete={() => props.onDelete(props.session.id)}
        />
      </Show>
    </li>
  )
}
