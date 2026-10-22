import { createEffect, createSignal, Match, Show, Switch } from "solid-js"
import { Dialog } from "../../components/ui/dialog"
import { tr } from "../../i18n/i18n-context"

export function MediaPreview(props: { kind: "image" | "audio" | "video"; name: string; src?: string }) {
  const [expanded, setExpanded] = createSignal(false)
  const [failed, setFailed] = createSignal(false)
  createEffect(() => {
    props.src
    setFailed(false)
    setExpanded(false)
  })
  return (
    <figure class="conversation-attachment" data-kind={props.kind}>
      <Show
        when={props.src && !failed()}
        fallback={
          <span role="status" class="conversation-attachment__error">
            {tr("conversation.media-unavailable", { name: props.name })}
          </span>
        }
      >
        <Switch>
          <Match when={props.kind === "image"}>
            <button
              class="conversation-attachment__image"
              type="button"
              aria-label={tr("conversation.view-image", { name: props.name })}
              onClick={() => setExpanded(true)}
            >
              <img src={props.src} alt={props.name} loading="lazy" decoding="async" onError={() => setFailed(true)} />
            </button>
          </Match>
          <Match when={props.kind === "audio"}>
            <audio src={props.src} controls preload="none" aria-label={props.name} onError={() => setFailed(true)} />
          </Match>
          <Match when={props.kind === "video"}>
            <video
              src={props.src}
              controls
              playsinline
              preload="none"
              aria-label={props.name}
              onError={() => setFailed(true)}
            />
          </Match>
        </Switch>
      </Show>
      <Show when={props.kind !== "image"}>
        <figcaption title={props.name}>{props.name}</figcaption>
      </Show>
      <Show when={expanded()}>
        <Dialog open title={props.name} showClose class="conversation-image-dialog" onClose={() => setExpanded(false)}>
          <img src={props.src} alt={props.name} decoding="async" />
        </Dialog>
      </Show>
    </figure>
  )
}
