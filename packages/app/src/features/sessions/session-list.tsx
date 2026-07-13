import type { Session, SessionStatus } from "@jyycode-ai/sdk/v2/client"
import { For, Show } from "solid-js"
import { Button } from "../../components/ui/button"
import { InlineError } from "../../components/ui/inline-error"
import { Spinner } from "../../components/ui/spinner"
import { SessionListItem } from "./session-list-item"

export type SessionListProps = {
  sessions: readonly Session[]
  statuses: Record<string, SessionStatus>
  activeSessionID?: string
  archived: boolean
  loading?: boolean
  error?: string
  disabled?: boolean
  onRetry?: () => void
  onNavigate?: () => void
  onRename: (sessionID: string, title: string) => Promise<void>
  onArchive: (sessionID: string) => Promise<void>
  onDelete: (sessionID: string) => Promise<void>
}

export function sortRootSessions(sessions: readonly Session[]) {
  return [...sessions]
    .filter((session) => session.parentID === undefined)
    .sort((left, right) => right.time.updated - left.time.updated || right.id.localeCompare(left.id))
}

export function SessionList(props: SessionListProps) {
  const sorted = () =>
    sortRootSessions(props.sessions).filter((session) =>
      props.archived ? session.time.archived !== undefined : session.time.archived === undefined,
    )

  return (
    <nav class="session-list" aria-label={props.archived ? "归档 Session" : "活动 Session"}>
      <Show
        when={!props.loading}
        fallback={
          <div class="session-list__loading" role="status" aria-live="polite">
            <Spinner /> 正在加载 Session
          </div>
        }
      >
        <Show when={!props.error} fallback={<SessionListError message={props.error!} onRetry={props.onRetry} />}>
          <Show when={sorted().length > 0}>
            <ul>
              <For each={sorted()}>
                {(session) => (
                  <SessionListItem
                    session={session}
                    status={props.statuses[session.id]}
                    active={props.activeSessionID === session.id}
                    archived={props.archived}
                    disabled={props.disabled}
                    onNavigate={props.onNavigate}
                    onRename={props.onRename}
                    onArchive={props.onArchive}
                    onDelete={props.onDelete}
                  />
                )}
              </For>
            </ul>
          </Show>
        </Show>
      </Show>
    </nav>
  )
}

function SessionListError(props: { message: string; onRetry?: () => void }) {
  return (
    <div class="session-list__error">
      <InlineError message={props.message} />
      <Show when={props.onRetry}>
        <Button size="small" variant="secondary" onClick={props.onRetry}>
          重新加载
        </Button>
      </Show>
    </div>
  )
}
