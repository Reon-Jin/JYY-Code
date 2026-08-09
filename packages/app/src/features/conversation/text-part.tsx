import type { TextPart } from "@jyycode-ai/sdk/v2/client"
import { createEffect, createSignal, onCleanup } from "solid-js"
import { renderMarkdown } from "./markdown"
import { incrementUIPerformanceCounter } from "../../performance/ui-performance"

const STREAMING_RENDER_INTERVAL_MS = 75

export function TextPartView(props: { part: TextPart }) {
  const [source, setSource] = createSignal(props.part.text)
  let pending = props.part.text
  let timer: number | undefined

  const flush = () => {
    timer = undefined
    if (pending !== source()) {
      incrementUIPerformanceCounter("streaming-renders")
      setSource(pending)
    }
  }

  createEffect(() => {
    pending = props.part.text
    if (pending === source()) return
    if (props.part.time?.end !== undefined) {
      if (timer !== undefined) window.clearTimeout(timer)
      flush()
      return
    }
    if (timer === undefined) timer = window.setTimeout(flush, STREAMING_RENDER_INTERVAL_MS)
  })

  onCleanup(() => {
    if (timer !== undefined) window.clearTimeout(timer)
  })

  return (
    <div
      class="conversation-markdown"
      innerHTML={renderMarkdown(source(), props.part.time?.end === undefined ? "streaming" : "complete")}
    />
  )
}
