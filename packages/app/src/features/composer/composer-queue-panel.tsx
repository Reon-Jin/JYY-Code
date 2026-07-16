import { tr } from "../../i18n/i18n-context"
import { Clock3, MessageSquareMore, Trash2 } from "lucide-solid"
import { createSignal, For } from "solid-js"
import { IconButton } from "../../components/ui/button"
import type { QueuedPrompt } from "./composer-queue"

export function ComposerQueuePanel(props: {
  items: readonly QueuedPrompt[]
  onGuide: (id: string) => void
  onMove: (id: string, targetID: string, after: boolean) => void
  onRemove: (id: string) => void
}) {
  const [draggedID, setDraggedID] = createSignal<string>()

  return (
    <section class="composer-queue" aria-label={tr("composer.messages-waiting-in-queue")}>
      <header class="composer-queue__header">
        <span>
          <Clock3 aria-hidden="true" />
          {tr("composer.waiting-in-line")} {props.items.length}
        </span>
        <small>{tr("composer.current-replies-will-be-sent-in-sequence-after")}</small>
      </header>
      <ol class="composer-queue__list">
        <For each={props.items}>
          {(item, index) => (
            <li
              draggable={true}
              data-dragging={draggedID() === item.id ? "true" : undefined}
              onDragStart={(event) => {
                const transfer = event.dataTransfer
                if (!transfer) return
                setDraggedID(item.id)
                transfer.effectAllowed = "move"
                transfer.setData("text/plain", item.id)
              }}
              onDragOver={(event) => {
                const transfer = event.dataTransfer
                if (!transfer || !draggedID() || draggedID() === item.id) return
                event.preventDefault()
                transfer.dropEffect = "move"
              }}
              onDrop={(event) => {
                event.preventDefault()
                const sourceID = draggedID() ?? event.dataTransfer?.getData("text/plain")
                if (!sourceID) return
                const bounds = event.currentTarget.getBoundingClientRect()
                props.onMove(sourceID, item.id, event.clientY > bounds.top + bounds.height / 2)
                setDraggedID(undefined)
              }}
              onDragEnd={() => setDraggedID(undefined)}
            >
              <span class="composer-queue__index">{index() + 1}</span>
              <p>{item.text || item.attachments.map((attachment) => attachment.filename).join(", ")}</p>
              <IconButton
                label={tr("composer.steer-queued-message", { index: index() + 1 })}
                variant="ghost"
                onClick={() => props.onGuide(item.id)}
              >
                <MessageSquareMore aria-hidden="true" />
              </IconButton>
              <IconButton label={tr("composer.remove-queued-message", { index: index() + 1 })} variant="ghost" onClick={() => props.onRemove(item.id)}>
                <Trash2 aria-hidden="true" />
              </IconButton>
            </li>
          )}
        </For>
      </ol>
    </section>
  )
}
