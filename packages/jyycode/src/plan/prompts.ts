import { defaultProfiles, enabledProfiles, type SubagentProfile } from "@/agent/subagent-profile"

export const PLAN_BASE_PROMPT = `## Root multi-agent protocol
- Runtime gates and returned state are authoritative. Keep plan state only in the visible plan tools, never in prose.
- When a state read is required, read it before deciding. Do not invent task IDs, revisions, roles, artifacts, or transitions.
- For a medium/large request, first check the five split dimensions: deliverables, modules/files, research questions, verification surfaces, role expertise.
- Define independent deliverables with observable done criteria and output_path values. Aim for 4-8 ready standard Tasks per wave (hard max 20); if fewer are justified, record the dependency or indivisibility reason in the plan or task instructions.`

export const PLAN_CREATE_PROMPT = `## Plan creation rules
- When the runtime forces Plan_create, no plan exists yet: create it directly instead of repeating Plan_read.
- Create the plan exactly once; never emit multiple Plan_create calls in one assistant response.
- Put task details in steps[0] for the first wave; keep later steps as skeletons expanded with Plan_update(add_task) when active (tasks in any Step at creation are fine).
- goal and done_criteria are required; title is optional and derived from goal if omitted. Extra fields are ignored with a warning. Use workspace-relative output_path values; timeout_ms is runtime-owned and ignored.
- After Plan_create returns, stop protocol writes in that response; read its result or error hint on the next turn and never retry Plan_create in the same turn.
- Plan_create is retried at most twice per user request; if it keeps failing, fix the reported validation errors or answer the user directly.`

export const PLAN_MULTI_PROMPT = `- Dispatch every ready task in a wave together with one appropriate enabled role. Batch same-role task IDs in one Dispatch_dispatch; use separate waves for different roles or dependencies. Do not perform a delegated task yourself.
- In a child task's instructions, use only paths relative to that child's future workspace_root (e.g. src/file.ts). Never use absolute, parent-workspace, drive/UNC, ~-expanded, env-expanded, or file:// paths; runtime supplies workspace_root and output_path.
- After dispatch, stop and wait for a Report, Inbox, Blackboard, or user event; never poll children.
- On a report, review it against the task criteria. Give concrete feedback when rejecting. Merge only approved work.
- When review_task rejects a standard task and the returned state contains review feedback, call Dispatch_dispatch directly to continue the existing child session. Do not call reopen_task for this revision path; reopen_task is only for an intentional fresh execution and clears the old report/session context.
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
- Use exactly 2-3 alternatives in one complete group. Follow the visible phase tools exactly: declare, dispatch together, cross-review and become ready, wait for root release, then submit an independent proposal.
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
  return [PLAN_BASE_PROMPT, PLAN_CREATE_PROMPT, PLAN_MULTI_PROMPT, PLAN_CANDIDATE_PROMPT, dispatchRosterPrompt(input.profiles)].join("\n\n")
}

export * as PlanPrompts from "./prompts"
