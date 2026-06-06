/**
 * Stub — reactive compaction is not yet implemented.
 * Returns no-op values so the compaction pipeline compiles.
 */

import type { MessageV2 } from "./message-v2"

export type ReactiveCompactConfig = Record<string, unknown>

export type ReactiveCompactState = {
  enabled: boolean
  lastCheck: number
}

export function detectReactiveCompactTrigger(
  _messages: readonly MessageV2.WithParts[],
): boolean {
  return false
}

export function shouldAttemptReactiveCompact(
  _state: ReactiveCompactState,
  _config?: ReactiveCompactConfig,
): boolean {
  return false
}

export function createReactiveCompactState(
  _config?: ReactiveCompactConfig,
): ReactiveCompactState {
  return { enabled: false, lastCheck: 0 }
}
