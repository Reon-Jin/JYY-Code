import type { SessionMessage } from "@jyycode-ai/core/session-message"
import type { MessageV2 } from "@/session/message-v2"

export type PublicMessage = {
  kind: "user" | "assistant" | "compaction"
  text: string[]
  reasoning: string[]
  tools: Array<{
    name: string
    status: string
    input: unknown
    output?: string
  }>
  finish?: string
  cost?: number
  tokens?: unknown
  time: { completed: boolean }
}

// These are intentionally explicit. They are useful EventV2 records, but do
// not have a one-to-one legacy MessageV2 message, so parity excludes them.
export const EVENT_ONLY_DROP_LIST = ["agent-switched", "model-switched", "synthetic", "shell"] as const

const textFromEventContent = (content: readonly SessionMessage.AssistantContent[]) =>
  content.filter((item): item is SessionMessage.AssistantText => item.type === "text").map((item) => item.text)

const reasoningFromEventContent = (content: readonly SessionMessage.AssistantContent[]) =>
  content
    .filter((item): item is SessionMessage.AssistantReasoning => item.type === "reasoning")
    .map((item) => item.text)

const toolsFromEventContent = (content: readonly SessionMessage.AssistantContent[]) =>
  content
    .filter((item): item is SessionMessage.AssistantTool => item.type === "tool")
    .map((item) => ({
      name: item.name,
      status: item.state.status,
      input: "input" in item.state ? item.state.input : undefined,
      output:
        item.state.status === "completed"
          ? item.state.content
              .filter((content) => content.type === "text")
              .map((content) => content.text)
              .join("")
          : item.state.status === "error"
            ? item.state.error.message
            : undefined,
    }))

function normalizeLegacyMessage(message: MessageV2.WithParts): PublicMessage | undefined {
  if (message.info.role === "user") {
    return {
      kind: "user",
      text: message.parts
        .filter((part): part is MessageV2.TextPart => part.type === "text" && !part.synthetic && !part.ignored)
        .map((part) => part.text),
      reasoning: [],
      tools: [],
      time: { completed: false },
    }
  }

  if (message.info.role !== "assistant") return undefined
  return {
    kind: "assistant",
    text: message.parts
      .filter((part): part is MessageV2.TextPart => part.type === "text" && !part.synthetic && !part.ignored)
      .map((part) => part.text),
    reasoning: message.parts
      .filter((part): part is MessageV2.ReasoningPart => part.type === "reasoning")
      .map((part) => part.text),
    tools: message.parts
      .filter((part): part is MessageV2.ToolPart => part.type === "tool")
      .map((part) => ({
        name: part.tool,
        status: part.state.status,
        input: "input" in part.state ? part.state.input : undefined,
        output:
          part.state.status === "completed"
            ? part.state.output
            : part.state.status === "error"
              ? part.state.error
              : undefined,
      })),
    finish: message.info.finish,
    cost: message.info.cost,
    tokens: message.info.tokens,
    time: { completed: message.info.time.completed !== undefined },
  }
}

function normalizeEventMessage(message: SessionMessage.Message): PublicMessage | undefined {
  if (EVENT_ONLY_DROP_LIST.includes(message.type as (typeof EVENT_ONLY_DROP_LIST)[number])) return undefined
  if (message.type === "user") {
    return {
      kind: "user",
      text: [message.text],
      reasoning: [],
      tools: [],
      time: { completed: false },
    }
  }
  if (message.type === "compaction") {
    return {
      kind: "compaction",
      text: [message.summary],
      reasoning: [],
      tools: [],
      time: { completed: true },
    }
  }
  if (message.type !== "assistant") return undefined
  return {
    kind: "assistant",
    text: textFromEventContent(message.content),
    reasoning: reasoningFromEventContent(message.content),
    tools: toolsFromEventContent(message.content),
    finish: message.finish,
    cost: message.cost,
    tokens: message.tokens,
    time: { completed: message.time.completed !== undefined },
  }
}

export function normalizeLegacyMessages(messages: readonly MessageV2.WithParts[]) {
  return messages.flatMap((message) => {
    const normalized = normalizeLegacyMessage(message)
    return normalized ? [normalized] : []
  })
}

export function normalizeEventMessages(messages: readonly SessionMessage.Message[]) {
  return messages.flatMap((message) => {
    const normalized = normalizeEventMessage(message)
    return normalized ? [normalized] : []
  })
}

export function parityDiff(legacy: readonly MessageV2.WithParts[], eventV2: readonly SessionMessage.Message[]) {
  const left = normalizeLegacyMessages(legacy)
  const right = normalizeEventMessages(eventV2)
  return {
    legacy: left,
    eventV2: right,
    equal: JSON.stringify(left) === JSON.stringify(right),
  }
}
