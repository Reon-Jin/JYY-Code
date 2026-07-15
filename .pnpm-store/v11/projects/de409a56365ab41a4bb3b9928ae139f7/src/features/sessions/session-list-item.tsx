import type { Session, SessionStatus } from "@jyycode-ai/sdk/v2/client"
import { A } from "@solidjs/router"
import { Circle, Clock3 } from "lucide-solid"
import { createEffect, createSignal, onCleanup, Show } from "solid-js"
import { Button } from "../../components/ui/button"
import { InlineError } from "../../components/ui/inline-error"
import { errorMessage } from "../projects/project-controller"
import { SessionActions } from "./session-actions"

export function relativeSessionTime(created: number, now = Date.now()) {
  const elapsed = Math.max(0, now - created)
  const minutes = Math.floor(elapsed / 60_000)
  if (minutes < 1) return "刚刚"
  if (minutes < 60) return `${minutes} 分钟前`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours} 小时前`
  const days = Math.floor(hours / 24)
  if (days < 7) return `${days} 天前`
  return new Intl.DateTimeFormat("zh-CN", { month: "short", day: "numeric" }).format(created)
}

function statusText(status: SessionStatus | undefined) {
  switch (status?.type) {
    case "busy":
      return "生成中"
    case "retry":
      return "等待重试"
    default:
      return "空闲"
  }
}

export type SessionListItemProps = {
  session: Session
  status?: SessionStatus
  active: boolean
  archived: boolean
  disabled?: boolean
  onNavigate?: () => void
  onRename: (sessionID: string, title: string) => Promise<void>
  onArchive: (sessionID: string) => Promise<void>
  onDelete: (sessionID: string) => Promise<void>
}

export function SessionListItem(props: SessionListItemProps) {
  const [now, setNow] = createSignal(Date.now())
  const [editing, setEditing] = createSignal(false)
  const [title, setTitle] = createSignal(props.session.title)
  const [saving, setSaving] = createSignal(false)
  const [error, setError] = createSignal<string>()
  let input: HTMLInputElement | undefined

  const clock = window.setInterval(() => setNow(Date.now()), 60_000)
  onCleanup(() => window.clearInterval(clock))

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
      setError("名称不能为空")
      input?.focus()
      return
    }

    setSaving(true)
    setError(undefined)
    try {
      await props.onRename(props.session.id, nextTitle)
      setEditing(false)
    } catch (cause) {
      setError(errorMessage(cause, "无法重命名 Session"))
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
              重命名 {props.session.title}
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
              <Button type="submit" size="small" loading={saving()} loadingLabel="保存中">
                保存名称
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
                取消
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
              {relativeSessionTime(props.session.time.created, now())}
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
