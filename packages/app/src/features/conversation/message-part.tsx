import type { Part } from "@jyycode-ai/sdk/v2/client"
import { File as FileIcon } from "lucide-solid"
import { Match, Switch } from "solid-js"
import { ReasoningPartView } from "./reasoning-part"
import { presentMessageText } from "./message-presentation"
import { TextPartView } from "./text-part"
import { ToolCallCard } from "./tool-call-card"

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
          <figure class="conversation-attachment" data-kind={part().mime.startsWith("image/") ? "image" : "file"}>
            {part().mime.startsWith("image/") ? (
              <img src={part().url} alt={part().filename ?? part().mime} loading="lazy" />
            ) : (
              <FileIcon aria-hidden="true" />
            )}
            <figcaption title={part().filename ?? part().mime}>{part().filename ?? part().mime}</figcaption>
          </figure>
        )}
      </Match>
    </Switch>
  )
}
