import type { Message, Part, TextPart } from "@jyycode-ai/sdk/v2/client"
import type { ConversationMessage } from "./conversation-state"

export type MessageTextPresentation = { kind: "hidden" } | { kind: "text"; text: string }

export function presentMessageText(input: {
  part: Pick<TextPart, "text" | "synthetic">
  role?: string
  agent?: string
}): MessageTextPresentation {
  if (input.part.synthetic) return { kind: "hidden" }
  return { kind: "text", text: input.part.text }
}

export type PresentedConversationMessage = {
  info: Message
  groups: PresentedMessageGroup[]
}

export type PresentedMessageGroup = { type: "content"; parts: Part[] } | { type: "activity"; parts: Part[] }

function isActivityPart(part: Part) {
  return part.type === "reasoning" || part.type === "tool"
}

function isVisiblePart(part: Part, message: ConversationMessage) {
  // Step markers and patch snapshots are internal metadata used for
  // undo/revert and session diffing, not user-facing chat content.
  if (part.type === "step-start" || part.type === "step-finish" || part.type === "patch") return false
  if (part.type !== "text") return true
  if (!part.text.trim()) return false
  return (
    presentMessageText({
      part,
      role: message.info.role,
      agent: message.info.role === "assistant" ? (message.info.agent ?? message.info.mode) : message.info.agent,
    }).kind !== "hidden"
  )
}

const visiblePartsByMessage = new WeakMap<ConversationMessage, readonly Part[]>()

function visibleParts(message: ConversationMessage) {
  const cached = visiblePartsByMessage.get(message)
  if (cached) return cached
  const parts = message.parts.filter((part) => isVisiblePart(part, message))
  visiblePartsByMessage.set(message, parts)
  return parts
}

/**
 * Converts transport messages into user-facing response blocks. Internal-only
 * messages disappear, and streaming assistant steps from the same Agent become
 * one response with one consolidated activity section.
 */
export function presentConversationMessages(messages: readonly ConversationMessage[]): PresentedConversationMessage[] {
  const presented: PresentedConversationMessage[] = []

  for (const message of messages) {
    const parts = visibleParts(message)
    if (parts.length === 0) continue

    const previous = presented.at(-1)
    const canMerge =
      message.info.role === "assistant" &&
      previous?.info.role === "assistant" &&
      (previous.info.agent ?? previous.info.mode) === (message.info.agent ?? message.info.mode)

    if (canMerge) {
      appendPresentedParts(previous.groups, parts)
      continue
    }

    const groups: PresentedMessageGroup[] = []
    appendPresentedParts(groups, parts)
    presented.push({ info: message.info, groups })
  }

  return presented
}

function appendPresentedParts(groups: PresentedMessageGroup[], parts: readonly Part[]) {
  for (const part of parts) {
    const type = isActivityPart(part) ? "activity" : "content"
    const previous = groups.at(-1)
    if (previous?.type === type) previous.parts.push(part)
    else groups.push({ type, parts: [part] })
  }
}
