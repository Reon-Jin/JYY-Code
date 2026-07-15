import type { TextPart } from "@jyycode-ai/sdk/v2/client"
import { createEffect, createSignal, onCleanup } from "solid-js"
import { renderMarkdown } from "./markdown"

export function TextPartView(props: { part: TextPart }) {
  const [source, setSource] = createSignal(props.part.text)
  let pending = props.part.text
  let frame: number | undefined

  createEffect(() => {
    pending = props.part.text
    if (pending === source() || frame !== undefined) return
    frame = window.requestAnimationFrame(() => {
      frame = undefined
      setSource(pending)
    })
  })

  onCleanup(() => {
    if (frame !== undefined) window.cancelAnimationFrame(frame)
  })

  return <div class="conversation-markdown" innerHTML={renderMarkdown(source())} />
}
