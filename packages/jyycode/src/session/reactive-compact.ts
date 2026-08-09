import type { MessageV2 } from "./message-v2"
import { Token } from "@/util/token"
import { microCompactOutput } from "./micro-compact"

const REACTIVE_PROMPT_TOKEN_LIMIT = 120_000
const REACTIVE_MEDIA_BYTES_LIMIT = 16 * 1024 * 1024
const DEFAULT_RECENT_USER_TURNS = 2
const DEFAULT_TOOL_OUTPUT_CHARS = 2_000
const DEFAULT_ASSISTANT_TEXT_CHARS = 3_000

export type ReactiveCompactConfig = {
  enabled?: boolean
  recentUserTurns?: number
  maxToolOutputChars?: number
  maxAssistantTextChars?: number
}

export type ReactiveCompactState = {
  enabled: boolean
  lastCheck: number
  attempts: number
}

export type ReactiveCompactStats = {
  changed: boolean
  messagesChanged: number
  partsChanged: number
  compactedToolOutputs: number
  compactedAssistantText: number
  preservedActiveParts: number
  beforeChars: number
  afterChars: number
  savedChars: number
}

export type ReactiveCompactResult = {
  messages: MessageV2.WithParts[]
  stats: ReactiveCompactStats
}

function dataUrlBytes(url: string) {
  const marker = ";base64,"
  const index = url.indexOf(marker)
  if (index < 0) return 0
  const value = url.slice(index + marker.length)
  const padding = value.endsWith("==") ? 2 : value.endsWith("=") ? 1 : 0
  return Math.max(0, Math.floor((value.length * 3) / 4) - padding)
}

function serializedChars(messages: readonly MessageV2.WithParts[]) {
  try {
    return JSON.stringify(messages).length
  } catch {
    return messages.reduce((total, message) => total + message.parts.length, 0)
  }
}

function textCompact(text: string, maxChars: number) {
  if (maxChars <= 0 || text.length <= maxChars) return undefined
  const head = Math.max(1, Math.floor(maxChars * 0.55))
  const tail = Math.max(1, maxChars - head)
  const content = `${text.slice(0, head)}\n[reactive-compacted: older assistant context hidden]\n${text.slice(-tail)}`
  return content.length < text.length ? content : undefined
}

function isProtectedTool(tool: string) {
  return /^(?:Plan|Dispatch|Blackboard|Candidate|Goal|Report|permission)/i.test(tool)
}

function isActive(part: MessageV2.Part) {
  return part.type === "tool" && (part.state.status === "pending" || part.state.status === "running")
}

function recentTurnStart(messages: readonly MessageV2.WithParts[], keepTurns: number) {
  const users = messages
    .map((message, index) => (message.info.role === "user" ? index : -1))
    .filter((index) => index >= 0)
  if (!users.length) return 0
  return users[Math.max(0, users.length - Math.max(1, keepTurns))] ?? 0
}

export function reactiveCompact(input: {
  messages: MessageV2.WithParts[]
  config?: ReactiveCompactConfig
}): ReactiveCompactResult {
  const config = input.config ?? {}
  const source = input.messages
  if (config.enabled === false) {
    const messages = structuredClone(source)
    const chars = serializedChars(messages)
    return {
      messages,
      stats: {
        changed: false,
        messagesChanged: 0,
        partsChanged: 0,
        compactedToolOutputs: 0,
        compactedAssistantText: 0,
        preservedActiveParts: messages.reduce(
          (total, message) =>
            total +
            message.parts.filter(
              (part) => part.type === "tool" && (part.state.status === "pending" || part.state.status === "running"),
            ).length,
          0,
        ),
        beforeChars: chars,
        afterChars: chars,
        savedChars: 0,
      },
    }
  }
  const result = structuredClone(source)
  const keepFrom = recentTurnStart(result, config.recentUserTurns ?? DEFAULT_RECENT_USER_TURNS)
  const maxToolOutputChars = config.maxToolOutputChars ?? DEFAULT_TOOL_OUTPUT_CHARS
  const maxAssistantTextChars = config.maxAssistantTextChars ?? DEFAULT_ASSISTANT_TEXT_CHARS
  let messagesChanged = 0
  let partsChanged = 0
  let compactedToolOutputs = 0
  let compactedAssistantText = 0
  let preservedActiveParts = 0

  for (let messageIndex = 0; messageIndex < result.length; messageIndex++) {
    const message = result[messageIndex]!
    if (messageIndex >= keepFrom || message.info.role === "user") {
      preservedActiveParts += message.parts.filter(isActive).length
      continue
    }

    let messageChanged = false
    for (const part of message.parts) {
      if (isActive(part)) {
        preservedActiveParts++
        continue
      }
      if (part.type === "tool" && part.state.status === "completed") {
        if (isProtectedTool(part.tool)) continue
        const compacted = microCompactOutput(part.state.output, maxToolOutputChars)
        const compactedContent = compacted?.content ?? textCompact(part.state.output, maxToolOutputChars)
        if (!compactedContent) continue
        part.state.output = compactedContent
        compactedToolOutputs++
        partsChanged++
        messageChanged = true
        continue
      }
      if (part.type === "text" && message.info.role === "assistant") {
        const compacted = textCompact(part.text, maxAssistantTextChars)
        if (!compacted) continue
        part.text = compacted
        compactedAssistantText++
        partsChanged++
        messageChanged = true
      }
      if (part.type === "reasoning") {
        const compacted = textCompact(part.text, maxAssistantTextChars)
        if (!compacted) continue
        part.text = compacted
        partsChanged++
        messageChanged = true
      }
    }
    if (messageChanged) messagesChanged++
  }

  const beforeChars = serializedChars(source)
  const afterChars = serializedChars(result)
  return {
    messages: result,
    stats: {
      changed: partsChanged > 0,
      messagesChanged,
      partsChanged,
      compactedToolOutputs,
      compactedAssistantText,
      preservedActiveParts,
      beforeChars,
      afterChars,
      savedChars: Math.max(0, beforeChars - afterChars),
    },
  }
}

export function detectReactiveCompactTrigger(messages: readonly MessageV2.WithParts[]): boolean {
  let mediaBytes = 0
  for (const message of messages) {
    for (const part of message.parts) {
      if (part.type === "file") mediaBytes += dataUrlBytes(part.url)
      if (part.type === "tool" && part.state.status === "completed") {
        for (const attachment of part.state.attachments ?? []) mediaBytes += dataUrlBytes(attachment.url)
      }
    }
  }
  if (mediaBytes >= REACTIVE_MEDIA_BYTES_LIMIT) return true
  return Token.estimate(JSON.stringify(messages)) >= REACTIVE_PROMPT_TOKEN_LIMIT
}

export function shouldAttemptReactiveCompact(state: ReactiveCompactState, config?: ReactiveCompactConfig): boolean {
  if (!state.enabled || config?.enabled === false) return false
  state.lastCheck = Date.now()
  state.attempts++
  return true
}

export function createReactiveCompactState(config?: ReactiveCompactConfig): ReactiveCompactState {
  return { enabled: config?.enabled !== false, lastCheck: 0, attempts: 0 }
}
