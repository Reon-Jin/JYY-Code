/**
 * Structural limits for agent session ancestry.
 *
 * Permission rules are intentionally not consulted here.  They can reduce
 * what a child may do, but they must never be able to increase the number of
 * child sessions that can be created.
 */
export const DEFAULT_HARD_MAX_AGENT_DEPTH = 1
export const MAX_SOFT_AGENT_DEPTH = 3

export type AgentDepthNode = {
  id: string
  parentID?: string | null
  agentDepth?: number | null
}

export type AgentDepthErrorCode =
  | "PARENT_MISSING"
  | "PARENT_CYCLE"
  | "DEPTH_INVALID"
  | "DEPTH_EXCEEDED"

export class SubagentDepthError extends Error {
  readonly code: AgentDepthErrorCode

  constructor(code: AgentDepthErrorCode, message: string) {
    super(message)
    this.name = "SubagentDepthError"
    this.code = code
  }
}

/**
 * A future soft limit may be configured up to three levels, but the current
 * hard cap remains authoritative and cannot be raised by a caller.
 */
export function effectiveAgentDepthLimit(requested?: number) {
  const soft =
    requested === undefined || !Number.isSafeInteger(requested)
      ? DEFAULT_HARD_MAX_AGENT_DEPTH
      : Math.max(0, Math.min(MAX_SOFT_AGENT_DEPTH, requested))
  return Math.min(DEFAULT_HARD_MAX_AGENT_DEPTH, soft)
}

function validateDepth(value: number, label: string) {
  if (!Number.isSafeInteger(value) || value < 0)
    throw new SubagentDepthError("DEPTH_INVALID", `${label} must be a non-negative integer`)
}

/**
 * Walk the persisted parent chain.  The caller supplies a lookup function so
 * this invariant can be used by both the session service and isolated tests.
 */
export function collectParentChain(input: {
  sessionID: string
  parentID?: string | null
  lookup: (id: string) => AgentDepthNode | undefined
}) {
  const chain: AgentDepthNode[] = []
  const seen = new Set<string>([input.sessionID])
  let currentID = input.parentID ?? undefined

  while (currentID) {
    if (seen.has(currentID))
      throw new SubagentDepthError("PARENT_CYCLE", `parent cycle detected at session ${currentID}`)
    seen.add(currentID)

    const node = input.lookup(currentID)
    if (!node) throw new SubagentDepthError("PARENT_MISSING", `parent session not found: ${currentID}`)
    chain.push(node)
    currentID = node.parentID ?? undefined
  }

  return chain
}

/**
 * Compute a new session's depth from ancestry.  `agentDepth` is read-only
 * metadata here; it is never accepted as an input to session creation.
 */
export function computeAgentDepth(input: {
  sessionID: string
  parentID?: string | null
  lookup: (id: string) => AgentDepthNode | undefined
  maxDepth?: number
}) {
  const chain = collectParentChain(input)
  for (const [index, node] of chain.entries()) {
    const expected = chain.length - index - 1
    if (node.agentDepth !== undefined && node.agentDepth !== null) {
      validateDepth(node.agentDepth, `agentDepth for ${node.id}`)
      if (node.agentDepth !== expected)
        throw new SubagentDepthError(
          "DEPTH_INVALID",
          `agent depth mismatch for ${node.id}: stored ${node.agentDepth}, expected ${expected}`,
        )
    }
  }

  const depth = chain.length
  const limit = effectiveAgentDepthLimit(input.maxDepth)
  if (depth > limit)
    throw new SubagentDepthError("DEPTH_EXCEEDED", `agent depth ${depth} exceeds hard limit ${limit}`)
  return depth
}

/**
 * Dispatch-side guard.  The child depth is returned so callers cannot invent
 * a second value for the same creation request.
 */
export function assertCanSpawnSubagent(parentDepth: number, maxDepth?: number) {
  validateDepth(parentDepth, "parent agent depth")
  const childDepth = parentDepth + 1
  const limit = effectiveAgentDepthLimit(maxDepth)
  if (childDepth > limit)
    throw new SubagentDepthError("DEPTH_EXCEEDED", `child agent depth ${childDepth} exceeds hard limit ${limit}`)
  return childDepth
}
