import type { AssistantMessage, Session } from "@jyycode-ai/sdk/v2/client"
import type { ConversationMessage } from "../conversation/conversation-state"

export type TokenUsageBreakdown = {
  input: number
  output: number
  reasoning: number
  cache: number
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

function billedFromMessages(messages: readonly ConversationMessage[]) {
  const tokens: TokenUsageBreakdown = { input: 0, output: 0, reasoning: 0, cache: 0, total: 0 }
  let cost = 0
  let found = false

  const add = (usage: NonNullable<Session["tokens"]>) => {
    tokens.input += usage.input
    tokens.output += usage.output
    tokens.reasoning += usage.reasoning
    tokens.cache += usage.cache.read + usage.cache.write
    found = true
  }

  for (const message of messages) {
    if (message.info.role !== "assistant") continue
    // The billing ledger is cumulative for this assistant message. Its plain
    // `tokens` field is only the latest context snapshot and must not be summed.
    if (message.info.usage?.billing) {
      add(message.info.usage.billing)
      cost += message.info.usage.cost
      continue
    }
    // Older messages predate the billing ledger, but persist billed step parts.
    for (const part of message.parts) {
      if (part.type !== "step-finish") continue
      add(part.tokens)
      cost += part.cost
    }
  }

  if (!found) return undefined
  tokens.total = tokens.input + tokens.output + tokens.reasoning + tokens.cache
  return { tokens, cost }
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

export function aggregateSessionUsage(root: Session, messages: readonly ConversationMessage[] = []) {
  // The workspace list contains root sessions only. A partial child list must
  // not be presented as a complete main + subagent total.
  const input = root.tokens?.input ?? 0
  const output = root.tokens?.output ?? 0
  const reasoning = root.tokens?.reasoning ?? 0
  const cache = (root.tokens?.cache.read ?? 0) + (root.tokens?.cache.write ?? 0)
  const total = input + output + reasoning + cache
  const billed = billedFromMessages(messages)
  return {
    // Message history is complete in the composer. It can be ahead of a
    // session row while the backfill or live session-query refresh is pending.
    tokens: billed && billed.tokens.total > total ? billed.tokens : { input, output, reasoning, cache, total },
    cost: Math.max(root.cost ?? 0, billed?.cost ?? 0),
  }
}

export function composerUsageMetrics(input: {
  session: Session
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
    ...(input.session.parentID ? {} : { aggregate: aggregateSessionUsage(input.session, input.messages) }),
  }
}
