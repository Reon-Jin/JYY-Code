import { Show } from 'solid-js'

interface Props {
  unreadCount: number
  onOpen: () => void
}

export function EmailPanel(props: Props) {
  return (
    <button class="email-card" onClick={props.onOpen}>
      <div>
        <span class="eyebrow">Inbox</span>
        <h3>Email tasks</h3>
        <p>{props.unreadCount > 0 ? `${props.unreadCount} unread messages` : 'No unread messages'}</p>
      </div>
      <Show when={props.unreadCount > 0}>
        <span class="badge-count">{props.unreadCount}</span>
      </Show>
    </button>
  )
}
