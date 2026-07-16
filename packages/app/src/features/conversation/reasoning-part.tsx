import { tr } from "../../i18n/i18n-context"
import type { ReasoningPart } from "@jyycode-ai/sdk/v2/client"
import { Brain, ChevronDown } from "lucide-solid"
import { createSignal, createUniqueId, Show } from "solid-js"

export function ReasoningPartView(props: { part: ReasoningPart }) {
  const [expanded, setExpanded] = createSignal(false)
  const contentID = createUniqueId()

  return (
    <section class="reasoning-part">
      <button
        type="button"
        class="reasoning-part__toggle"
        aria-expanded={expanded()}
        aria-controls={contentID}
        onClick={() => setExpanded((value) => !value)}
      >
        <Brain aria-hidden="true" />
        {tr("conversation.thought-process")}
        <ChevronDown aria-hidden="true" data-expanded={expanded() ? "true" : undefined} />
      </button>
      <Show when={expanded()}>
        <pre id={contentID} class="reasoning-part__content">
          {props.part.text}
        </pre>
      </Show>
    </section>
  )
}
