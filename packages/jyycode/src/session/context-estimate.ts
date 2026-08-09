import { Token } from "@/util/token"
import { isMedia } from "@/util/media"
import type { MessageV2 } from "./message-v2"

const MESSAGE_OVERHEAD_TOKENS = 8
const MEDIA_TOKEN_PER_64KB = 512
const MAX_MEDIA_TOKENS_PER_ATTACHMENT = 32_000

export type ContextEstimate = {
  textTokens: number
  systemTokens: number
  injectedTokens: number
  toolSchemaTokens: number
  toolArgumentTokens: number
  toolTokens: number
  mediaTokens: number
  mediaBytes: number
  overheadTokens: number
  safetyMarginTokens: number
  outputReserve: number
  inputTokens: number
  totalTokens: number
}

export type ContextBudgetInput = {
  messages: MessageV2.WithParts[]
  system: string[]
  tools: Record<string, { inputSchema: unknown; description?: string }>
  injectedContext: string[]
  outputReserve: number
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

function stringify(value: unknown) {
  try {
    const result = JSON.stringify(value)
    return result === undefined ? "" : result
  } catch {
    return "[unserializable]"
  }
}

export function estimateContextTokens(
  input: ContextBudgetInput | { messages: readonly MessageV2.WithParts[] },
): ContextEstimate {
  const fullRequest = "system" in input
  const system = fullRequest ? input.system : []
  const tools = fullRequest ? input.tools : {}
  const injectedContext = fullRequest ? input.injectedContext : []
  const outputReserve = fullRequest && Number.isFinite(input.outputReserve) ? Math.max(0, input.outputReserve) : 0
  let textTokens = 0
  let systemTokens = 0
  let injectedTokens = 0
  let toolSchemaTokens = 0
  let toolArgumentTokens = 0
  let toolTokens = 0
  let mediaTokens = 0
  let mediaBytes = 0
  let overheadTokens = 0

  for (const value of system) systemTokens += addText(value)
  for (const value of injectedContext) injectedTokens += addText(value)
  for (const definition of Object.values(tools)) {
    toolSchemaTokens += addText(definition.description)
    toolSchemaTokens += addText(stringify(definition.inputSchema))
  }

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
        toolArgumentTokens += addText(stringify(part.state.input))
        for (const attachment of part.state.attachments ?? []) {
          if (!isMedia(attachment.mime)) continue
          const bytes = dataUrlBytes(attachment.url)
          mediaBytes += bytes
          mediaTokens += estimateMediaTokens(bytes)
        }
        continue
      }

      if (part.type === "tool") {
        toolArgumentTokens += addText(stringify(part.state.input))
        continue
      }

      if (part.type === "reasoning") {
        textTokens += addText(part.text)
      }
    }
  }

  const rawInputTokens =
    textTokens +
    systemTokens +
    injectedTokens +
    toolSchemaTokens +
    toolArgumentTokens +
    toolTokens +
    mediaTokens +
    overheadTokens
  // Token.estimate is intentionally lightweight and has no provider tokenizer.
  // Keep legacy message-only callers byte-for-byte compatible, while complete
  // request estimates carry a conservative safety margin.
  const safetyMarginTokens = fullRequest ? Math.ceil(rawInputTokens * 0.1) : 0
  const inputTokens = rawInputTokens + safetyMarginTokens
  const totalTokens = inputTokens + outputReserve
  return {
    textTokens,
    systemTokens,
    injectedTokens,
    toolSchemaTokens,
    toolArgumentTokens,
    toolTokens,
    mediaTokens,
    mediaBytes,
    overheadTokens,
    safetyMarginTokens,
    outputReserve,
    inputTokens,
    totalTokens,
  }
}
