import { Tool } from "./tool"

export type PartitionInput = {
  tools: Tool.Def[]
  enabled: boolean
  threshold: number
}

export type PartitionResult = {
  direct: Tool.Def[]
  hidden: Tool.Def[]
}

const CORE_DIRECT_TOOL_IDS = new Set([
  "tool_search",
  "invalid",
  "read",
  "glob",
  "grep",
  "shell",
  "apply_patch",
  "edit",
  "write",
  "task",
  "task_status",
  "todo",
])

function shouldHide(tool: Tool.Def) {
  if (CORE_DIRECT_TOOL_IDS.has(tool.id)) return false
  if (tool.catalog?.category === "mcp") return true
  if (tool.catalog?.category === "communication") return true
  if (tool.catalog?.detail === "advanced") return true
  return false
}

export function partition(input: PartitionInput): PartitionResult {
  if (!input.enabled || input.tools.length <= input.threshold) {
    return { direct: input.tools, hidden: [] }
  }

  const direct: Tool.Def[] = []
  const hidden: Tool.Def[] = []

  for (const tool of input.tools) {
    if (shouldHide(tool)) hidden.push(tool)
    else direct.push(tool)
  }

  return { direct, hidden }
}

export * as ToolDisclosure from "./disclosure"
