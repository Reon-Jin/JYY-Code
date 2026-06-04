import { For, Show } from 'solid-js'
import type { SessionInfo } from '../../types/models'

interface Props {
  sessions: SessionInfo[]
  onSelect: (session: SessionInfo) => void
  onCreateNew: () => void
}

function formatTime(ts: number): string {
  const diff = Date.now() - ts
  const minutes = Math.floor(diff / 60000)
  const hours = Math.floor(diff / 3600000)
  const days = Math.floor(diff / 86400000)
  if (minutes < 1) return 'just now'
  if (minutes < 60) return `${minutes}m ago`
  if (hours < 24) return `${hours}h ago`
  return `${days}d ago`
}

export function SessionList(props: Props) {
  return (
    <Show
      when={props.sessions.length > 0}
      fallback={
        <div class="session-empty-card">
          <h3>No sessions yet</h3>
          <p>Create a new task to start streaming responses and tracking changes.</p>
          <button onClick={props.onCreateNew}>New task</button>
        </div>
      }
    >
      <div class="session-list">
        <For each={props.sessions}>
          {(session) => (
            <button class="session-card" onClick={() => props.onSelect(session)}>
              <span class="status-dot" data-state={session.status === 'running' ? 'run' : session.status === 'error' ? 'off' : 'on'} />
              <div>
                <strong>{session.title || 'Untitled task'}</strong>
                <span>
                  {session.model || 'No model'} · {session.messageCount} messages
                </span>
              </div>
              <em>{formatTime(session.updatedAt)}</em>
            </button>
          )}
        </For>
      </div>
    </Show>
  )
}
