import type { Config } from "@/config/config"
import type { Provider } from "@/provider/provider"
import { ProviderTransform } from "@/provider/transform"
import type { MessageV2 } from "./message-v2"

const COMPACTION_BUFFER = 20_000
const PREDICTIVE_RATIO = 0.92

// Context-aware buffer sizing — larger context windows need more headroom
// because a single turn can produce proportionally more tokens.
const AUTOCOMPACT_BUFFER_TOKENS = 13_000
const TOOL_RESULT_GROWTH_ESTIMATE = 15_000
export const WARNING_THRESHOLD_BUFFER = 20_000
export const ERROR_THRESHOLD_BUFFER = 20_000
export const MANUAL_COMPACT_BUFFER = 3_000

/**
 * Context-aware autocompact buffer. Larger context windows need more
 * headroom because a single turn can produce proportionally more tokens
 * (longer model outputs + larger tool results).
 */
export function getAutocompactBufferTokens(model: Provider.Model): number {
  const effectiveWindow = getEffectiveContextWindow(model)
  if (effectiveWindow >= 800_000) return 50_000
  if (effectiveWindow >= 400_000) return 30_000
  return AUTOCOMPACT_BUFFER_TOKENS
}

/**
 * Returns the effective context window (model context - max output tokens).
 */
export function getEffectiveContextWindow(model: Provider.Model): number {
  const maxOutput = Math.min(ProviderTransform.maxOutputTokens(model), COMPACTION_BUFFER)
  const contextWindow = model.limit.context
  return Math.max(0, contextWindow - maxOutput)
}

/**
 * Estimate max token growth a single turn can produce.
 * Used for predictive autocompact checks.
 */
export function estimateMaxTurnGrowth(model: Provider.Model): number {
  const maxOutput = Math.min(ProviderTransform.maxOutputTokens(model), COMPACTION_BUFFER)
  return maxOutput + TOOL_RESULT_GROWTH_ESTIMATE
}

export function usable(input: { cfg: Config.Info; model: Provider.Model; outputTokenMax?: number }) {
  const context = input.model.limit.context
  if (context === 0) return 0

  const reserved =
    input.cfg.compaction?.reserved ??
    Math.min(COMPACTION_BUFFER, ProviderTransform.maxOutputTokens(input.model, input.outputTokenMax))
  return input.model.limit.input
    ? Math.max(0, input.model.limit.input - reserved)
    : Math.max(0, context - ProviderTransform.maxOutputTokens(input.model, input.outputTokenMax))
}

/**
 * Returns the auto-compaction threshold for a given model.
 * This is the token count above which auto-compaction should trigger.
 */
export function getAutoCompactThreshold(input: { model: Provider.Model; config: Config.Info }): number {
  const effectiveWindow = getEffectiveContextWindow(input.model)
  const buffer = getAutocompactBufferTokens(input.model)
  return Math.max(0, effectiveWindow - buffer)
}

export function getPredictiveCompactThreshold(input: {
  cfg: Config.Info
  model: Provider.Model
  outputTokenMax?: number
}) {
  const configured = input.cfg.compaction?.trigger_ratio ?? PREDICTIVE_RATIO
  const ratio = Number.isFinite(configured) ? Math.max(0, Math.min(1, configured)) : PREDICTIVE_RATIO
  return Math.max(0, Math.floor(usable(input) * ratio))
}

/**
 * Calculate detailed token warning state for UI feedback.
 */
export function calculateTokenWarningState(input: { tokenUsage: number; model: Provider.Model; config: Config.Info }): {
  percentLeft: number
  isAboveWarningThreshold: boolean
  isAboveErrorThreshold: boolean
  isAboveAutoCompactThreshold: boolean
  isAtBlockingLimit: boolean
} {
  const autoCompactThreshold = getAutoCompactThreshold(input)
  const threshold =
    input.config.compaction?.auto !== false ? autoCompactThreshold : getEffectiveContextWindow(input.model)

  const percentLeft = threshold <= 0 ? 0 : Math.max(0, Math.round(((threshold - input.tokenUsage) / threshold) * 100))

  const warningThreshold = Math.max(0, threshold - WARNING_THRESHOLD_BUFFER)
  const errorThreshold = Math.max(0, threshold - ERROR_THRESHOLD_BUFFER)

  const isAboveWarningThreshold = input.tokenUsage >= warningThreshold
  const isAboveErrorThreshold = input.tokenUsage >= errorThreshold
  const isAboveAutoCompactThreshold =
    input.config.compaction?.auto !== false && input.tokenUsage >= autoCompactThreshold

  const actualContextWindow = getEffectiveContextWindow(input.model)
  const blockingLimit = Math.max(0, actualContextWindow - MANUAL_COMPACT_BUFFER)
  const isAtBlockingLimit = input.tokenUsage >= blockingLimit

  return {
    percentLeft,
    isAboveWarningThreshold,
    isAboveErrorThreshold,
    isAboveAutoCompactThreshold,
    isAtBlockingLimit,
  }
}

export function isOverflow(input: {
  cfg: Config.Info
  tokens: MessageV2.Assistant["tokens"]
  model: Provider.Model
  outputTokenMax?: number
}) {
  if (input.cfg.compaction?.auto === false) return false
  if (input.model.limit.context === 0) return false

  const count =
    input.tokens.total || input.tokens.input + input.tokens.output + input.tokens.cache.read + input.tokens.cache.write
  return count >= usable(input)
}

export function shouldCompact(input: {
  cfg: Config.Info
  model: Provider.Model
  estimatedInputTokens: number
  outputTokenMax?: number
}) {
  if (input.cfg.compaction?.auto === false) return false
  if (input.model.limit.context === 0) return false
  return input.estimatedInputTokens >= getPredictiveCompactThreshold(input)
}
