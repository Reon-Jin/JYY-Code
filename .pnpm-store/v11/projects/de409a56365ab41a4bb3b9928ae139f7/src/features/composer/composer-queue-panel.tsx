import { Clock3, Trash2 } from "lucide-solid"
import { For } from "solid-js"
import { IconButton } from "../../components/ui/button"
import type { QueuedPrompt } from "./composer-queue"

export function ComposerQueuePanel(props: { items: readonly QueuedPrompt[]; onRemove: (id: string) => void }) {
  return (
    <section class="composer-queue" aria-label="排队等待的消息">
      <header class="composer-queue__header">
        <span>
          <Clock3 aria-hidden="true" />
          排队等待 · {props.items.length}
        </span>
        <small>当前回复完成后将按顺序发送</small>
      </header>
      <ol class="composer-queue__list">
        <For each={props.items}>
          {(item, index) => (
            <li>
              <span class="composer-queue__index">{index() + 1}</span>
              <p>{item.text}</p>
              <IconButton label={`移除排队消息 ${index() + 1}`} variant="ghost" onClick={() => props.onRemove(item.id)}>
                <Trash2 aria-hidden="true" />
              </IconButton>
            </li>
          )}
        </For>
      </ol>
    </section>
  )
}
