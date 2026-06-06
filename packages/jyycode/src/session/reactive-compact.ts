/**
 * Reactive compaction: emergency compaction triggered when the API returns a
 * "prompt too long" or "media size" error. Catches the error and tries to
 * compact the conversation to stay within context limits.
 *
 * Ported from claudecode's src/services/compact/reactiveCompact.ts design.
 */
import { Effect } from "effect"
import type { MessageV2 } from "./message-v2"
import type { Provider } from "@/provider/provider"

/**
 * Check if an assistant message indicates a prompt-too-long API error.
 */
export function isPromptTooLong(message: MessageV2.WithParts): boolean {
  if (message.info.role !== "assistant") return false
  if (!message.info.error) return false
  const err = message.info.error
  return (
    typeof err === "object" &&
    err !== null &&
    "type" in err &&
    (err.type === "context_overflow" ||
      err.type === "prompt_too_long" ||
      (typeof (err as any).message === "string" &&
        ((err as any).message.includes("prompt is too long") ||
          (err as any).message.includes("context length"))))
  )
}

/**
 * Check if an assistant message indicates a media size error.
 */
export function isMediaSizeError(message: MessageV2.WithParts): boolean {
  if (message.info.role !== "assistant") return false
  if (!message.info.error) return false
  const err = message.info.error
  return (
    typeof err === "object" &&
    err !== null &&
    typeof (err as any).message === "string" &&
    ((err as any).message.includes("media") ||
      (err as any).message.includes("image") ||
      (err as any).message.includes("attachment") ||
      (err as any).message.includes("file size"))
  )
}

/**
 * Configuration for reactive compaction behavior.
 */
export interface ReactiveCompactConfig {
  /** Whether reactive compaction is enabled. Default true. */
  enabled: boolean
  /** Maximum number of reactive compact attempts per turn. Default 1. */
  maxAttemptsPerTurn: number
  /** Whether to be in reactive-only mode (suppress proactive autocompact). */
  reactiveOnly: boolean
}

export const DEFAULT_REACTIVE_CONFIG: ReactiveCompactConfig = {
  enabled: true,
  maxAttemptsPerTurn: 1,
  reactiveOnly: false,
}

/**
 * State tracking for reactive compaction within a single turn.
 */
export interface ReactiveCompactState {
  hasAttempted: boolean
  attemptCount: number
  lastAttemptTime: number
}

export function createReactiveCompactState(): ReactiveCompactState {
  return {
    hasAttempted: false,
    attemptCount: 0,
    lastAttemptTime: 0,
  }
}

/**
 * Determine whether reactive compaction should be attempted.
 */
export function shouldAttemptReactiveCompact(
  state: ReactiveCompactState,
  config: ReactiveCompactConfig,
): boolean {
  if (!config.enabled) return false
  if (config.reactiveOnly && state.attemptCount > 0) return false
  if (state.attemptCount >= config.maxAttemptsPerTurn) return false
  if (state.hasAttempted) return false

  // Debounce: don't try more than once per 500ms
  if (Date.now() - state.lastAttemptTime < 500) return false

  return true
}

/**
 * Check if the last assistant message in a conversation indicates a
 * context overflow or media size error that warrants reactive compaction.
 */
export function detectReactiveCompactTrigger(
  messages: MessageV2.WithParts[],
): "prompt_too_long" | "media_size" | null {
  const lastAssistant = messages.findLast((m) => m.info.role === "assistant")
  if (!lastAssistant) return null

  if (isPromptTooLong(lastAssistant)) return "prompt_too_long"
  if (isMediaSizeError(lastAssistant)) return "media_size"
  return null
}

/**
 * Estimate how many tokens the reactive compaction freed.
 * Used by the compaction tracking system after reactive compact completes.
 */
export function estimateReactiveCompactSavings(
  beforeCount: number,
  afterCount: number,
  model: Provider.Model,
): number {
  const contextWindow = model.limit.context
  if (contextWindow === 0) return 0

  // Rough estimate: if messages were reduced, savings is proportional
  const reduction = beforeCount - afterCount
  if (reduction <= 0) return 0

  // Conservative: assume each removed message averaged ~500 tokens
  return reduction * 500
}
