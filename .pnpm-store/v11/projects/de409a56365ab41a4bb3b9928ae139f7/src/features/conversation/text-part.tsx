import type { TextPart } from "@jyycode-ai/sdk/v2/client"
import { renderMarkdown } from "./markdown"

export function TextPartView(props: { part: TextPart }) {
  return <div class="conversation-markdown" innerHTML={renderMarkdown(props.part.text)} />
}
