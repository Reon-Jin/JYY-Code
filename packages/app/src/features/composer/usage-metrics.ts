import type { AssistantMessage, Session } from "@jyycode-ai/sdk/v2/client"
import type { ConversationMessage } from "../conversation/conversation-state"

export type TokenUsageBreakdown = {
  input: number
  output: number
  reasoning: number
  other: number
  subagents: number
  total: number
}

export type ComposerUsageMetrics = {
  contextWindow?: number
  contextUsed?: number
  contextPercent?: number
  aggregate?: {
    tokens: TokenUsageBreakdown
    cost: number
  }
}

function tokenTotal(tokens: NonNullable<Session["tokens"]>) {
  return tokens.input + tokens.output + tokens.reasoning + tokens.cache.read + tokens.cache.write
}

function sessionFamily(root: Session, sessions: readonly Session[]) {
  const ids = new Set([root.id])
  let changed = true
  while (changed) {
    changed = false
    for (const session of sessions) {
      if (!session.parentID || !ids.has(session.parentID) || ids.has(session.id)) continue
      ids.add(session.id)
      changed = true
    }
  }
  return [root, ...sessions.filter((session) => session.id !== root.id && ids.has(session.id))]
}

export function currentContextTokens(messages: readonly ConversationMessage[]) {
  const message = [...messages]
    .reverse()
    .find(
      (candidate): candidate is ConversationMessage & { info: AssistantMessage } =>
        candidate.info.role === "assistant" && tokenTotal(candidate.info.tokens) > 0,
    )
  return message ? tokenTotal(message.info.tokens) : undefined
}

export function aggregateSessionUsage(root: Session, sessions: readonly Session[]) {
  const family = sessionFamily(root, sessions)
  const main = root.tokens
  const children = family.filter((session) => session.id !== root.id)
  const subagents = children.reduce((total, session) => total + (session.tokens ? tokenTotal(session.tokens) : 0), 0)
  const input = main?.input ?? 0
  const output = main?.output ?? 0
  const reasoning = main?.reasoning ?? 0
  const other = (main?.cache.read ?? 0) + (main?.cache.write ?? 0)
  return {
    tokens: { input, output, reasoning, other, subagents, total: input + output + reasoning + other + subagents },
    cost: family.reduce((total, session) => total + (session.cost ?? 0), 0),
  }
}

export function composerUsageMetrics(input: {
  session: Session
  sessions: readonly Session[]
  messages: readonly ConversationMessage[]
  contextWindow?: number
}): ComposerUsageMetrics {
  const contextUsed = currentContextTokens(input.messages)
  const contextPercent =
    contextUsed !== undefined && input.contextWindow
      ? Math.min(100, Math.max(0, (contextUsed / input.contextWindow) * 100))
      : undefined
  return {
    contextWindow: input.contextWindow,
    contextUsed,
    contextPercent,
    ...(input.session.parentID ? {} : { aggregate: aggregateSessionUsage(input.session, input.sessions) }),
  }
}
