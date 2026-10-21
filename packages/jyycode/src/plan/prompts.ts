import { defaultProfiles, enabledProfiles, type SubagentProfile } from "@/agent/subagent-profile"

export const PLAN_BASE_PROMPT = `## Root multi-agent protocol
- Runtime gates and returned state are authoritative. Keep plan state in visible tools. Read required state before deciding; never invent IDs, revisions, roles, artifacts or transitions.
- For medium/large requests, split by deliverables, modules/files, research questions, verification surfaces and role expertise.
- Define independent deliverables with observable done criteria and output_path. Aim for 4-8 ready standard Tasks per wave (max 20); explain fewer by dependency or indivisibility.
- A Step contains all independent ready work across roles: research, documents, implementation and verification. Only artifact dependencies require later Steps. Never split independent work into one-Task Steps for isolation.
- Declare required files in Task inputs ([] if none). from_task must name an earlier Step's Task, reviewed and merged before dispatch. Same-Step dependencies are invalid. All batches and retries in a Step use its original frozen baseline.`

export const PLAN_CREATE_PROMPT = `## Plan creation rules
- When forced, call Plan_create directly; no plan exists yet. Do not repeat Plan_read.
- Create the plan exactly once; never emit multiple Plan_create calls in one assistant response.
- Detail steps[0]; keep later steps as skeletons expanded via Plan_update(add_task) when active, or detail them at creation.
- Require goal and done_criteria. title defaults to goal; extra fields warn and are ignored. output_path is workspace-relative; timeout_ms is runtime-owned.
- After Plan_create, stop protocol writes in that response. Read its result/error next turn; never retry Plan_create in the same turn.
- Retry Plan_create at most twice per request; fix validation errors or answer directly.`

export const PLAN_MULTI_PROMPT = `- Dispatch every ready task with an enabled role. Batch same-role IDs in one Dispatch_dispatch; dispatch other roles in the same Step without waiting. Do not perform delegated work yourself.
- Use only paths relative to that child's future workspace_root in its instructions. Never use absolute, parent-workspace, drive/UNC, ~, env-expanded or file:// paths; runtime supplies workspace_root and output_path.
- After dispatch, wait only if no report/event is actionable; never poll children.
- Review each standard Report against task criteria immediately; never wait for siblings. Record review_task; reject with concrete feedback. Merge only approved work.
- Reuse child verification evidence. Add checks only for missing or conflicting evidence; do not repeat a full review.
- For undispatched rejection feedback, call Dispatch_dispatch directly to continue the existing child session. Do not call reopen_task for this revision path. New work needs a new Task.
- Use Blackboard only for decisions, dependencies, risks, handoffs, blockers or targeted help; consume unread work before advancing.`

export const PLAN_SINGLE_PROMPT = ""

export const PLAN_CHILD_PROMPT = `## Child-agent protocol
- Runtime rules, visible tools, and your dispatch brief are authoritative. The brief defines your task, workspace_root, output_path, and done criteria; stay within that workspace.
- Your Step has one frozen baseline. Work independently using declared inputs and your own outputs; never wait for, read, or request a sibling's new artifact. Blackboard is for clarification and blockers, not bypassing the Step boundary. Report missing inputs so the root can replan the dependency into a later Step.
- When Blackboard is visible or required, read and handle it before work and before reporting. Share only material dependencies, risks, handoffs, blockers, or targeted help.
- Write the requested artifact first. Then report exactly once with real artifacts and an honest done, partial, or failed outcome. After a successful report, stop.
- Do not edit the parent plan, dispatch agents, or treat peer memory as your task. When previous feedback arrives, correct the artifact and report the result.`

export const PLAN_CANDIDATE_PROMPT = `## Candidate protocol
- Candidates compare competing approaches only: 2-3 alternatives in one group. Follow visible phase tools: declare, dispatch together, cross-review, become ready, wait for root release, submit independent proposals.
- After all proposals arrive, create a synthesis artifact in the root workspace before selection. Do not merge candidates as ordinary child work.`

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
  // Single-agent root sessions have no plan protocol: plan tools are hidden
  // entirely and the prompt must not reference them.
  if (!input.multiAgent) return ""
  return [
    PLAN_BASE_PROMPT,
    PLAN_CREATE_PROMPT,
    PLAN_MULTI_PROMPT,
    PLAN_CANDIDATE_PROMPT,
    dispatchRosterPrompt(input.profiles),
  ].join("\n\n")
}

export * as PlanPrompts from "./prompts"
