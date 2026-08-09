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

/** Internal marker used to admit only MCP tools with a positive read-only hint. */
export const SUBAGENT_READ_ONLY_MCP_TOOL_ID = "__subagent_read_only_mcp__"

const SAFE_DEFAULT_TOOL_IDS = ["read", "glob", "grep", "context_read"] as const
const ROLE_DEFAULT_TOOL_IDS: Record<string, readonly string[]> = {
  researcher: ["read", "glob", "grep", "websearch", "webfetch", "context_read", SUBAGENT_READ_ONLY_MCP_TOOL_ID],
  planner: ["read", "glob", "grep", "context_read"],
  implementer: ["read", "glob", "grep", "write", "edit", "bash"],
  reviewer: ["read", "glob", "grep", "bash", "context_read"],
}

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
  "Goal_done",
] as const

export function defaultSubagentToolIDs(profileID: string | undefined) {
  const role = profileID?.trim().toLowerCase()
  return [...(ROLE_DEFAULT_TOOL_IDS[role ?? ""] ?? SAFE_DEFAULT_TOOL_IDS)]
}

export function isSubagentSelectableToolID(id: string) {
  return (
    id !== "*" &&
    id !== SUBAGENT_READ_ONLY_MCP_TOOL_ID &&
    (SUBAGENT_SELECTABLE_TOOL_ID_SET.has(id) || (!isSubagentFixedToolID(id) && !isSubagentForbiddenToolID(id)))
  )
}

export function normalizeSubagentSelectableToolIDs(ids: readonly string[] | undefined) {
  const selected =
    ids === undefined
      ? SAFE_DEFAULT_TOOL_IDS
      : ids.filter((id) => id === SUBAGENT_READ_ONLY_MCP_TOOL_ID || isSubagentSelectableToolID(id))
  return new Set<string>(selected)
}

const READ_ONLY_SHELL_COMMANDS = new Set([
  "cat",
  "dir",
  "find",
  "findstr",
  "get-childitem",
  "get-content",
  "git diff",
  "git log",
  "git show",
  "git status",
  "grep",
  "ls",
  "pwd",
  "rg",
  "select-string",
  "type",
  "wc",
  "where",
  "whoami",
])

/** Conservative command gate for the reviewer role's shell surface. */
export function isReviewerReadOnlyShellCommand(command: string) {
  if (!command.trim() || /[;&|><`$()\r\n]/.test(command)) return false
  const tokens = command.trim().split(/\s+/)
  const first = tokens[0]?.toLowerCase().replace(/^["']|["']$/g, "")
  if (!first) return false
  const key = first === "git" ? `${first} ${tokens[1]?.toLowerCase() ?? ""}` : first
  return READ_ONLY_SHELL_COMMANDS.has(key)
}

export function isSubagentCandidateToolID(id: string) {
  return id.startsWith("Candidate.")
}

export function isSubagentFixedToolID(id: string) {
  return (
    SUBAGENT_FIXED_TOOL_IDS.includes(id as (typeof SUBAGENT_FIXED_TOOL_IDS)[number]) || isSubagentCandidateToolID(id)
  )
}

export function isSubagentForbiddenToolID(id: string) {
  return (
    SUBAGENT_FORBIDDEN_TOOL_IDS.includes(id as (typeof SUBAGENT_FORBIDDEN_TOOL_IDS)[number]) ||
    id.startsWith("Plan.") ||
    id.startsWith("Dispatch.")
  )
}

export * as SubagentToolPolicy from "./subagent-tool-policy"
