import type { Part } from "@jyycode-ai/sdk/v2/client"
import { Match, Switch } from "solid-js"
import { ReasoningPartView } from "./reasoning-part"
import { TextPartView } from "./text-part"
import { ToolCallCard } from "./tool-call-card"

export function MessagePartView(props: { part: Part }) {
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
      <Match when={props.part.type === "step-start" || props.part.type === "step-finish"}>{null}</Match>
      <Match when={props.part.type === "text" ? props.part : undefined}>
        {(part) => <TextPartView part={part()} />}
      </Match>
      <Match when={props.part.type === "reasoning" ? props.part : undefined}>
        {(part) => <ReasoningPartView part={part()} />}
      </Match>
      <Match when={props.part.type === "tool" ? props.part : undefined}>
        {(part) => <ToolCallCard part={part()} />}
      </Match>
    </Switch>
  )
}
