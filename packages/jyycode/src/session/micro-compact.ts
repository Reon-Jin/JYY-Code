/**
 * Micro-compaction: smart tool-result-level truncation before allowing results
 * into the context window. Identifies "compactable" tools whose output doesn't
 * need to be fully preserved and caps their result size.
 *
 * Ported from claudecode's src/services/compact/microCompact.ts design.
 */
import type { MessageV2 } from "./message-v2"

/** Tools whose results are safe to aggressively truncate. */
export const COMPACTABLE_TOOLS = new Set([
  "read",
  "shell",
  "grep",
  "glob",
  "webfetch",
  "websearch",
  "edit",
  "write",
])

/** Maximum characters to keep from a micro-compacted tool result. */
export const MICROCOMPACT_MAX_CHARS = 8_000

/** The sentinel message that replaces old tool result content after time-based clearing. */
export const TIME_BASED_CLEARED_MESSAGE =
  "[Old tool result content cleared]"

export interface MicroCompactConfig {
  /** Whether micro-compaction is enabled. Default true. */
  enabled: boolean
  /** Max characters to keep from tool results. Default MICROCOMPACT_MAX_CHARS. */
  maxChars: number
  /** Time in ms after which tool results are eligible for clearing. 0 = disabled. */
  timeThresholdMs: number
}

export const DEFAULT_MICROCOMPACT_CONFIG: MicroCompactConfig = {
  enabled: true,
  maxChars: MICROCOMPACT_MAX_CHARS,
  timeThresholdMs: 0,
}

/**
 * Returns true if a tool part is eligible for micro-compaction.
 */
export function isCompactable(part: MessageV2.ToolPart): boolean {
  return (
    COMPACTABLE_TOOLS.has(part.tool) &&
    part.state.status === "completed" &&
    !part.state.time.compacted
  )
}

/**
 * Micro-compact a single tool output, keeping the head of the result.
 * Returns the truncated content or undefined if no truncation was needed.
 */
export function microCompactOutput(
  output: string,
  maxChars: number = MICROCOMPACT_MAX_CHARS,
): { content: string; truncated: boolean; removedChars: number } | undefined {
  if (output.length <= maxChars) return undefined

  // Keep the first maxChars characters plus a truncation note.
  const kept = output.slice(0, maxChars)
  const removed = output.length - maxChars
  const note = `\n\n[... ${removed.toLocaleString()} characters truncated ...]`

  return {
    content: kept + note,
    truncated: true,
    removedChars: removed,
  }
}

/**
 * Time-based micro-compaction: clears tool results older than the threshold.
 * Returns the replacement message for expired content.
 */
export function timeBasedClear(
  part: MessageV2.ToolPart,
  thresholdMs: number,
): string | undefined {
  if (thresholdMs <= 0) return undefined
  if (!part.state.time.completed) return undefined

  const age = Date.now() - part.state.time.completed
  if (age < thresholdMs) return undefined

  return TIME_BASED_CLEARED_MESSAGE
}

/**
 * Estimate the tokens saved by micro-compacting a set of tool parts.
 */
export function estimateMicroCompactSavings(
  parts: MessageV2.ToolPart[],
  maxChars: number = MICROCOMPACT_MAX_CHARS,
): number {
  let savings = 0
  for (const part of parts) {
    if (!isCompactable(part)) continue
    if (part.state.output.length > maxChars) {
      // Rough estimate: 4 chars per token
      savings += Math.floor((part.state.output.length - maxChars) / 4)
    }
  }
  return savings
}
