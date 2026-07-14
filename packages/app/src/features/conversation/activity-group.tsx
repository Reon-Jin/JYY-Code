import type { Part } from "@jyycode-ai/sdk/v2/client"
import { ChevronDown, LoaderCircle } from "lucide-solid"
import { createSignal, createUniqueId, Show, type ParentProps } from "solid-js"

export type PartGroup =
  | { type: "activity"; id: string; parts: Part[] }
  | { type: "part"; id: string; part: Part }

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
    running?: boolean
    class?: string
  }>,
) {
  const [expanded, setExpanded] = createSignal(true)
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
        <Show when={props.running}>
          <LoaderCircle class="activity-group__spinner" aria-hidden="true" />
        </Show>
        <span>{props.label}</span>
        <small>{props.count} 项</small>
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
