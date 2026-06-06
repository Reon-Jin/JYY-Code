/**
 * Content replacement state — deterministic tool result budget enforcement
 * across conversation turns. Critical for prompt cache stability: by making
 * the same replacement decisions on resume, cache keys remain byte-identical.
 *
 * Ported from claudecode's src/utils/toolResultStorage.ts.
 */

/** Maximum characters to keep in-memory for a single tool result. */
export const DEFAULT_MAX_RESULT_SIZE_CHARS = 50_000

/** Maximum total characters for all tool results in a single message. */
export const MAX_TOOL_RESULTS_PER_MESSAGE_CHARS = 150_000

/** Preview size: first N bytes of a persisted result kept in the message. */
const PREVIEW_BYTES = 2_000

/**
 * Tracks which tool results have been replaced with persisted-file previews.
 * Stable across turns so the same tool results get the same treatment,
 * producing identical API messages for prompt cache hits.
 */
export interface ContentReplacementState {
  /** Set of tool use IDs that have already been replaced. */
  seenIds: Set<string>
  /** Map from tool use ID to replacement preview text. */
  replacements: Map<string, string>
}

export function createContentReplacementState(): ContentReplacementState {
  return {
    seenIds: new Set(),
    replacements: new Map(),
  }
}

/**
 * Reconstruct replacement state from persisted records (e.g., JSONL transcript).
 * Ensures resumed sessions make the same budget decisions.
 */
export function reconstructContentReplacementState(
  records: { toolUseId: string; preview: string }[],
): ContentReplacementState {
  const state = createContentReplacementState()
  for (const record of records) {
    state.seenIds.add(record.toolUseId)
    state.replacements.set(record.toolUseId, record.preview)
  }
  return state
}

/**
 * Check if a tool result exceeds the persistence threshold and should be
 * replaced with a disk-backed preview.
 */
export function shouldPersistToolResult(
  content: string,
  maxChars: number = DEFAULT_MAX_RESULT_SIZE_CHARS,
): boolean {
  return content.length > maxChars
}

/**
 * Generate a preview of a large tool result. Keeps the first PREVIEW_BYTES
 * bytes (truncated at a newline boundary for readability).
 */
export function generateToolResultPreview(content: string): {
  preview: string
  hasMore: boolean
  originalSize: number
} {
  const originalSize = Buffer.byteLength(content, "utf-8")
  if (originalSize <= PREVIEW_BYTES) {
    return { preview: content, hasMore: false, originalSize }
  }

  // Truncate at a newline boundary within the preview window
  let cutoff = PREVIEW_BYTES
  const slice = content.slice(0, PREVIEW_BYTES)
  const lastNewline = slice.lastIndexOf("\n")
  if (lastNewline > PREVIEW_BYTES / 2) {
    cutoff = lastNewline + 1
  }

  const preview = content.slice(0, cutoff)
  const remaining = originalSize - Buffer.byteLength(preview, "utf-8")
  const sizeStr =
    remaining > 1_000_000
      ? `${(remaining / 1_000_000).toFixed(1)}MB`
      : remaining > 1_000
        ? `${(remaining / 1_000).toFixed(0)}KB`
        : `${remaining}B`

  return {
    preview: `${preview}\n\n[... ${sizeStr} of output saved to disk ...]`,
    hasMore: true,
    originalSize,
  }
}

/**
 * Apply per-message aggregate budget enforcement. Given a list of tool
 * results that will be sent as a single API message, replace the largest
 * ones with previews until the total under the budget.
 *
 * Uses the content replacement state to ensure deterministic decisions.
 */
export function enforceToolResultBudget(
  results: { toolUseId: string; content: string }[],
  state: ContentReplacementState,
  maxTotalChars: number = MAX_TOOL_RESULTS_PER_MESSAGE_CHARS,
): { toolUseId: string; content: string }[] {
  // First pass: apply already-known replacements
  const withKnown: { toolUseId: string; content: string; size: number }[] = []
  let totalSize = 0

  for (const result of results) {
    if (state.replacements.has(result.toolUseId)) {
      const preview = state.replacements.get(result.toolUseId)!
      const size = Buffer.byteLength(preview, "utf-8")
      withKnown.push({ toolUseId: result.toolUseId, content: preview, size })
      totalSize += size
    } else {
      const size = Buffer.byteLength(result.content, "utf-8")
      withKnown.push({ ...result, size })
      totalSize += size
    }
  }

  if (totalSize <= maxTotalChars) {
    return withKnown.map(({ toolUseId, content }) => ({ toolUseId, content }))
  }

  // Second pass: replace largest results until under budget
  const sorted = [...withKnown].sort((a, b) => b.size - a.size)
  let excess = totalSize - maxTotalChars

  for (const entry of sorted) {
    if (excess <= 0) break
    if (entry.size <= PREVIEW_BYTES) continue

    const { preview } = generateToolResultPreview(entry.content)
    const newSize = Buffer.byteLength(preview, "utf-8")
    const saved = entry.size - newSize

    state.replacements.set(entry.toolUseId, preview)
    state.seenIds.add(entry.toolUseId)
    entry.content = preview
    entry.size = newSize
    excess -= saved
  }

  return sorted.map(({ toolUseId, content }) => ({ toolUseId, content }))
}

/**
 * Detect if the content was previously replaced and restore the preview.
 * Used when replaying/resuming conversations.
 */
export function applyReplacementState(
  toolUseId: string,
  content: string,
  state: ContentReplacementState,
): string {
  if (state.replacements.has(toolUseId)) {
    return state.replacements.get(toolUseId)!
  }
  state.seenIds.add(toolUseId)
  return content
}
