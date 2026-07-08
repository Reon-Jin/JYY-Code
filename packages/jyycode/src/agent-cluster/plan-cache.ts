// In-memory cache of cluster plan text keyed by runID.  Populated by the
// runLoop pre-persistence code as soon as the LLM produces a plan, and
// read by persistCurrentClusterPlan() in task.ts — eliminating the race
// between SyncEvent projector commits and concurrent tool execution.
// This race is especially pronounced in the TUI where the background
// server's DB connections may have different commit-visibility timing.
const cache = new Map<string, { text: string; at: number }>()
const TTL = 5 * 60 * 1000

function prune() {
  const cutoff = Date.now() - TTL
  for (const [key, entry] of cache) {
    if (entry.at < cutoff) cache.delete(key)
  }
}

export function storeClusterPlanText(runID: string, text: string) {
  cache.set(runID, { text, at: Date.now() })
  prune()
}

export function getClusterPlanText(runID: string): string | undefined {
  const entry = cache.get(runID)
  if (!entry) return undefined
  if (Date.now() - entry.at > TTL) {
    cache.delete(runID)
    return undefined
  }
  return entry.text
}
