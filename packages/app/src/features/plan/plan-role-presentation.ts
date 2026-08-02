import { tr } from "../../i18n/i18n-context"
import type { SubagentAvatarID } from "../subagents/subagent-avatar-catalog"

export type PlanRoleSnapshot = {
  id: string
  name: string
  description: string
  avatar: SubagentAvatarID
}

export function planRoleLabel(role: PlanRoleSnapshot | undefined) {
  return role?.name ?? tr("multi-agent.unassigned")
}

export function planRoleDescription(role: PlanRoleSnapshot | undefined) {
  return role?.description
}
