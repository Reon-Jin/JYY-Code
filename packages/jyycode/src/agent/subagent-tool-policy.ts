/**
 * Tool IDs that a role author may select for a profile-backed subagent.
 *
 * Terminal tools (bash, process) are always part of this set so every
 * subagent can run shell commands without any user configuration. Protocol,
 * orchestration, and memory tools are controlled by the runtime instead of
 * being user-configurable role permissions. Plugin and MCP IDs are accepted
 * as dynamic user-configurable tools after this built-in set.
 */
export const SUBAGENT_SELECTABLE_TOOL_IDS = [
  "read",
  "edit",
  "write",
  "glob",
  "grep",
  "websearch",
  "webfetch",
  "bash",
  "process",
] as const

export const SUBAGENT_SELECTABLE_TOOL_ID_SET = new Set<string>(SUBAGENT_SELECTABLE_TOOL_IDS)

/** Always available to a normal child session when the surrounding protocol requires them. */
export const SUBAGENT_FIXED_TOOL_IDS = ["skill", "Report", "Blackboard", "Blackboard.reply"] as const

/** Candidate protocol tools are fixed, but the phase gate decides which one is visible at a given turn. */
export const SUBAGENT_CANDIDATE_TOOL_IDS = [
  "Candidate.declare",
  "Candidate.ready",
  "Candidate.begin",
  "Candidate.submit",
] as const

/** Tools that must never be included in a profile-backed subagent catalog. */
export const SUBAGENT_FORBIDDEN_TOOL_IDS = [
  "tool_search",
  "invalid",
  "question",
  "memory",
  "Inbox",
  "Plan.read",
  "Plan.create",
  "Plan.update",
  "Dispatch.dispatch",
  "Dispatch.roles",
  "Dispatch.cancel",
] as const

export function isSubagentSelectableToolID(id: string) {
  return SUBAGENT_SELECTABLE_TOOL_ID_SET.has(id) || (!isSubagentFixedToolID(id) && !isSubagentForbiddenToolID(id))
}

export function normalizeSubagentSelectableToolIDs(ids: readonly string[] | undefined) {
  const selected = ids === undefined ? SUBAGENT_SELECTABLE_TOOL_IDS : ids.filter(isSubagentSelectableToolID)
  return new Set<string>(selected)
}

export function isSubagentCandidateToolID(id: string) {
  return id.startsWith("Candidate.")
}

export function isSubagentFixedToolID(id: string) {
  return SUBAGENT_FIXED_TOOL_IDS.includes(id as (typeof SUBAGENT_FIXED_TOOL_IDS)[number]) || isSubagentCandidateToolID(id)
}

export function isSubagentForbiddenToolID(id: string) {
  return (
    SUBAGENT_FORBIDDEN_TOOL_IDS.includes(id as (typeof SUBAGENT_FORBIDDEN_TOOL_IDS)[number]) ||
    id.startsWith("Plan.") ||
    id.startsWith("Dispatch.")
  )
}

export * as SubagentToolPolicy from "./subagent-tool-policy"
