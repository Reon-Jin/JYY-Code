import type { TextPart } from "@jyycode-ai/sdk/v2/client"
import { createEffect, createSignal, onCleanup } from "solid-js"
import { MarkdownView } from "./markdown-view"
import { incrementUIPerformanceCounter } from "../../performance/ui-performance"

const STREAMING_RENDER_INTERVAL_MS = 32

export function TextPartView(props: { part: TextPart }) {
  const [source, setSource] = createSignal(props.part.text)
  let pending = props.part.text
  let timer: number | undefined
  let frame: number | undefined
  let fallback: number | undefined
  let partID = props.part.id
  let lastFlushAt = Number.NEGATIVE_INFINITY

  const cancel = () => {
    if (timer !== undefined) window.clearTimeout(timer)
    if (frame !== undefined) window.cancelAnimationFrame(frame)
    if (fallback !== undefined) window.clearTimeout(fallback)
    timer = frame = fallback = undefined
  }

  const flush = () => {
    cancel()
    lastFlushAt = performance.now()
    if (pending !== source()) {
      incrementUIPerformanceCounter("streaming-renders")
      setSource(pending)
    }
  }

  createEffect(() => {
    pending = props.part.text
    if (partID !== props.part.id || props.part.time?.end !== undefined) {
      partID = props.part.id
      flush()
      return
    }
    if (pending === source() || timer !== undefined || frame !== undefined) return
    timer = window.setTimeout(
      () => {
        timer = undefined
        frame = window.requestAnimationFrame(flush)
        // An occluded WebView may suspend frames while still reporting visible.
        fallback = window.setTimeout(flush, 120)
      },
      Math.max(0, STREAMING_RENDER_INTERVAL_MS - (performance.now() - lastFlushAt)),
    )
  })

  onCleanup(cancel)
  return <MarkdownView source={source()} mode={props.part.time?.end === undefined ? "streaming" : "complete"} />
}
