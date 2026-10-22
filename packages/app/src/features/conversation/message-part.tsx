import type { FilePart, Part } from "@jyycode-ai/sdk/v2/client"
import { File as FileIcon } from "lucide-solid"
import { createEffect, createSignal, Match, Show, Switch } from "solid-js"
import { Dialog } from "../../components/ui/dialog"
import { useOptionalData } from "../../data/context"
import { tr } from "../../i18n/i18n-context"
import { ReasoningPartView } from "./reasoning-part"
import { presentMessageText } from "./message-presentation"
import { TextPartView } from "./text-part"
import { ToolCallCard } from "./tool-call-card"

export function ImageAttachment(props: { part: FilePart }) {
  const data = useOptionalData()
  const [expanded, setExpanded] = createSignal(false)
  const [failed, setFailed] = createSignal(false)
  const source = () =>
    props.part.url.startsWith("data:image/") || props.part.url.startsWith("blob:http")
      ? props.part.url
      : data?.attachmentUrl(props.part)
  const label = () => props.part.filename ?? props.part.mime
  createEffect(() => {
    source()
    setFailed(false)
    setExpanded(false)
  })
  return (
    <figure class="conversation-attachment" data-kind="image">
      <Show
        when={source() && !failed()}
        fallback={
          <span class="conversation-attachment__error" role="status">
            {tr("conversation.image-unavailable")}
          </span>
        }
      >
        <button
          class="conversation-attachment__image"
          type="button"
          aria-label={tr("conversation.view-image", { name: label() })}
          onClick={() => setExpanded(true)}
        >
          <img src={source()} alt={label()} loading="lazy" decoding="async" onError={() => setFailed(true)} />
        </button>
      </Show>
      <Show when={expanded()}>
        <Dialog open title={label()} showClose class="conversation-image-dialog" onClose={() => setExpanded(false)}>
          <img src={source()} alt={label()} decoding="async" />
        </Dialog>
      </Show>
    </figure>
  )
}

export function MessagePartView(props: { part: Part; messageRole?: string; messageAgent?: string }) {
  return (
    <Switch
      fallback={
        import.meta.env.DEV ? (
          <div class="unsupported-part" role="note">
            Unsupported content: {props.part.type}
          </div>
        ) : null
      }
    >
      {/* Internal metadata (step markers, patch snapshots) never renders. */}
      <Match
        when={props.part.type === "step-start" || props.part.type === "step-finish" || props.part.type === "patch"}
      >
        {null}
      </Match>
      <Match when={props.part.type === "text" ? props.part : undefined}>
        {(part) => {
          const presentation = () =>
            presentMessageText({ part: part(), role: props.messageRole, agent: props.messageAgent })
          return (
            <Switch>
              <Match when={presentation().kind === "hidden"}>{null}</Match>
              <Match when={presentation().kind === "text"}>
                <TextPartView part={{ ...part(), text: (presentation() as { kind: "text"; text: string }).text }} />
              </Match>
            </Switch>
          )
        }}
      </Match>
      <Match when={props.part.type === "reasoning" ? props.part : undefined}>
        {(part) => <ReasoningPartView part={part()} />}
      </Match>
      <Match when={props.part.type === "tool" ? props.part : undefined}>
        {(part) => <ToolCallCard part={part()} />}
      </Match>
      <Match when={props.part.type === "file" ? props.part : undefined}>
        {(part) => (
          <Show
            when={part().mime.startsWith("image/")}
            fallback={
              <figure class="conversation-attachment" data-kind="file">
                <FileIcon aria-hidden="true" />
                <figcaption title={part().filename ?? part().mime}>{part().filename ?? part().mime}</figcaption>
              </figure>
            }
          >
            <ImageAttachment part={part()} />
          </Show>
        )}
      </Match>
    </Switch>
  )
}
