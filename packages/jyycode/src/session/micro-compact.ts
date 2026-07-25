/**
 * Stub — micro-compaction is not yet implemented.
 * Returns no-op values so the compaction pipeline compiles.
 */

export function isCompactable(_part: unknown): boolean {
  return false
}

export function microCompactOutput(_output: string): { content: string } | null {
  return null
}

export function estimateMicroCompactSavings(_messages: unknown[]): number {
  return 0
}
