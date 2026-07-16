import type { PermissionRuleset } from "@jyycode-ai/sdk/v2/client"

export type AgentPermissionMode = "request" | "auto" | "full"

export function permissionRulesForMode(mode: AgentPermissionMode): PermissionRuleset {
  if (mode === "auto") return []
  return [{ permission: "*", pattern: "*", action: mode === "request" ? "ask" : "allow" }]
}

export function permissionModeFromRules(rules: PermissionRuleset | undefined): AgentPermissionMode {
  for (let index = (rules?.length ?? 0) - 1; index >= 0; index -= 1) {
    const rule = rules![index]
    if (!rule) continue
    if (rule.permission !== "*" || rule.pattern !== "*") continue
    if (rule.action === "ask") return "request"
    if (rule.action === "allow") return "full"
    break
  }
  return "auto"
}
