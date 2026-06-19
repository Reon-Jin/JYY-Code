import { Token } from "@/util/token"
import { isMedia } from "@/util/media"
import type { MessageV2 } from "./message-v2"

const MESSAGE_OVERHEAD_TOKENS = 8
const MEDIA_TOKEN_PER_64KB = 512
const MAX_MEDIA_TOKENS_PER_ATTACHMENT = 32_000

export type ContextEstimate = {
  textTokens: number
  toolTokens: number
  mediaTokens: number
  mediaBytes: number
  overheadTokens: number
  totalTokens: number
}

function dataUrlBytes(url: string) {
  const marker = ";base64,"
  const index = url.indexOf(marker)
  if (index < 0) return 0
  const base64 = url.slice(index + marker.length)
  const padding = base64.endsWith("==") ? 2 : base64.endsWith("=") ? 1 : 0
  return Math.max(0, Math.floor((base64.length * 3) / 4) - padding)
}

function estimateMediaTokens(bytes: number) {
  if (bytes <= 0) return 0
  return Math.min(MAX_MEDIA_TOKENS_PER_ATTACHMENT, Math.ceil(bytes / (64 * 1024)) * MEDIA_TOKEN_PER_64KB)
}

function addText(value: string | undefined) {
  return value ? Token.estimate(value) : 0
}

export function estimateContextTokens(input: { messages: readonly MessageV2.WithParts[] }): ContextEstimate {
  let textTokens = 0
  let toolTokens = 0
  let mediaTokens = 0
  let mediaBytes = 0
  let overheadTokens = 0

  for (const message of input.messages) {
    if (message.parts.length > 0) overheadTokens += MESSAGE_OVERHEAD_TOKENS

    for (const part of message.parts) {
      if (part.type === "text" && !part.ignored) {
        textTokens += addText(part.text)
        continue
      }

      if (part.type === "file") {
        if (isMedia(part.mime)) {
          const bytes = dataUrlBytes(part.url)
          mediaBytes += bytes
          mediaTokens += estimateMediaTokens(bytes)
        } else {
          textTokens += addText(part.filename)
        }
        continue
      }

      if (part.type === "tool" && part.state.status === "completed") {
        toolTokens += addText(part.state.time.compacted ? "[Old tool result content cleared]" : part.state.output)
        for (const attachment of part.state.attachments ?? []) {
          if (!isMedia(attachment.mime)) continue
          const bytes = dataUrlBytes(attachment.url)
          mediaBytes += bytes
          mediaTokens += estimateMediaTokens(bytes)
        }
        continue
      }

      if (part.type === "reasoning") {
        textTokens += addText(part.text)
      }
    }
  }

  const totalTokens = textTokens + toolTokens + mediaTokens + overheadTokens
  return { textTokens, toolTokens, mediaTokens, mediaBytes, overheadTokens, totalTokens }
}
