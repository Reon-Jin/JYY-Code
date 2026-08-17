import { tr } from "../../i18n/i18n-context"
import type { Part } from "@jyycode-ai/sdk/v2/client"
import { ChevronDown } from "lucide-solid"
import { createSignal, createUniqueId, Show, type ParentProps } from "solid-js"
import { ThinkingOrb } from "../../components/ui/thinking-orb"

export type PartGroup = { type: "activity"; id: string; parts: Part[] } | { type: "part"; id: string; part: Part }

function isActivityPart(part: Part) {
  return part.type === "reasoning" || part.type === "tool"
}

function isStepMarker(part: Part) {
  return part.type === "step-start" || part.type === "step-finish"
}

export function groupMessageParts(parts: readonly Part[]): PartGroup[] {
  const groups: PartGroup[] = []
  let activity: Part[] = []

  function flushActivity() {
    const first = activity[0]
    if (!first) return
    groups.push({ type: "activity", id: first.id, parts: activity })
    activity = []
  }

  for (const part of parts) {
    if (isActivityPart(part)) {
      activity.push(part)
      continue
    }
    if (isStepMarker(part)) continue
    flushActivity()
    groups.push({ type: "part", id: part.id, part })
  }
  flushActivity()
  return groups
}

export function ActivityGroup(
  props: ParentProps<{
    label: string
    count: number
    pending?: boolean
    defaultExpanded?: boolean
    class?: string
  }>,
) {
  const [expanded, setExpanded] = createSignal(props.defaultExpanded ?? false)
  const contentID = createUniqueId()

  return (
    <section class={`activity-group${props.class ? ` ${props.class}` : ""}`}>
      <button
        type="button"
        class="activity-group__toggle"
        aria-expanded={expanded()}
        aria-controls={contentID}
        onClick={() => setExpanded((value) => !value)}
      >
        <Show when={props.pending}>
          <ThinkingOrb state="searching" size={20} theme="light" class="activity-group__spinner" aria-hidden="true" />
        </Show>
        <span>{props.label}</span>
        <Show when={props.count > 0}>
          <small>
            {props.count} {tr("conversation.item")}
          </small>
        </Show>
        <ChevronDown aria-hidden="true" data-expanded={expanded() ? "true" : undefined} />
      </button>
      <Show when={expanded()}>
        <div id={contentID} class="activity-group__content">
          {props.children}
        </div>
      </Show>
    </section>
  )
}
