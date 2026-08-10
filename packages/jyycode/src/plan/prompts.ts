import { defaultProfiles, enabledProfiles, type SubagentProfile } from "@/agent/subagent-profile"

export const PLAN_BASE_PROMPT = `## Root multi-agent protocol
- Runtime gates and returned state are authoritative. Keep plan state only in the visible plan tools, never in prose.
- When a state read is required, read it before deciding. Do not invent task IDs, revisions, roles, artifacts, or transitions.
- For an active step, define independent, non-overlapping deliverables with observable done criteria and output_path values.`

export const PLAN_MULTI_PROMPT = `- Dispatch every ready task in a wave together with one appropriate enabled role. Do not perform a delegated task yourself.
- In a child task's instructions, use only paths relative to that child's future workspace_root (for example, src/file.ts). Never include an absolute path, parent workspace name, drive/UNC path, ~ expansion, environment expansion, or file URI; runtime supplies workspace_root and output_path.
- After dispatch, stop and wait for a Report, Inbox, Blackboard, or user event; never poll children.
- On a report, inspect current state and review it against the task criteria. Give concrete feedback when rejecting. Merge only approved work.
- Use Blackboard only for decisions, dependencies, risks, handoffs, blockers, or targeted help. Consume unread Blackboard work before advancing a step.`

export const PLAN_SINGLE_PROMPT = `## Root single-agent protocol
- Use plan tools only when phases, dependencies, or explicit acceptance require tracked state. Keep plan state in those tools, not prose.
- Follow the returned task state and revision. Satisfy observable done criteria before approving or advancing work.`

export const PLAN_CHILD_PROMPT = `## Child-agent protocol
- Runtime rules, visible tools, and your dispatch brief are authoritative. The brief defines your task, workspace_root, output_path, and done criteria; stay within that workspace.
- When Blackboard is visible or required, read and handle it before work and before reporting. Share only material dependencies, risks, handoffs, blockers, or targeted help.
- Write the requested artifact first. Then report exactly once with real artifacts and an honest done, partial, or failed outcome. After a successful report, stop.
- Do not edit the parent plan, dispatch agents, or treat peer memory as your task. When previous feedback arrives, correct the artifact and report the result.`

export const PLAN_CANDIDATE_PROMPT = `## Candidate protocol
- Use candidate tasks only to compare genuinely competing approaches, never as ordinary parallel work.
- Initialize and dispatch the complete candidate group together. Follow the visible phase tools exactly: declare, cross-review and become ready, wait for root release, then submit an independent proposal.
- After every proposal arrives, create a real synthesis artifact in the root workspace before selecting one candidate. Candidate tasks are not merged as ordinary child work.`

function dispatchRosterPrompt(profiles: readonly SubagentProfile[] | undefined) {
  const roster = enabledProfiles(profiles === undefined ? defaultProfiles() : profiles)
  return [
    "## Dispatchable roles",
    ...(roster.length > 0
      ? roster.map((profile) => {
          const model = profile.model ?? "parent model"
          const variant = profile.variant ? `; thinking=${profile.variant}` : ""
          return `- ${profile.id}: ${profile.description}; model=${model}${variant}`
        })
      : ["No enabled sub-agent roles are currently available."]),
    "Use the returned role ID exactly. Role prompts provide domain method; runtime tools and dispatch briefs provide operational constraints.",
  ].join("\n")
}

export function planSystemPrompt(input: {
  child: boolean
  multiAgent: boolean
  profiles?: readonly SubagentProfile[]
}) {
  if (input.child) return PLAN_CHILD_PROMPT
  if (!input.multiAgent) return PLAN_SINGLE_PROMPT
  return [PLAN_BASE_PROMPT, PLAN_MULTI_PROMPT, PLAN_CANDIDATE_PROMPT, dispatchRosterPrompt(input.profiles)].join("\n\n")
}

export * as PlanPrompts from "./prompts"
