import { Session } from "@/session/session"
import { SessionID } from "@/session/schema"
import { Config } from "@/config/config"
import { Project } from "@/project/project"
import { Worktree } from "@/worktree"
import { enabledProfiles, profileAgentName, resolveProfiles, type SubagentProfile } from "@/agent/subagent-profile"
import { Provider } from "@/provider/provider"
import { Bus } from "@/bus"
import { Tool } from "@/tool/tool"
import { EffectBridge, type Shape as EffectBridgeShape } from "@/effect/bridge"
import type { TaskPromptOps } from "@/session/tools"
import type { JSONSchema7 } from "@ai-sdk/provider"
import { Cause, Effect, Option, Schema } from "effect"
import path from "node:path"
import { Global } from "@jyycode-ai/core/global"
import {
  PlanProtocol,
  parentSessionIdForRunId,
  registerChildRun,
  registerChildBudget,
  clearChildBudget,
  takeChildBudgetFailure,
  runIdForChildSession,
  planRootForRunId,
  markChildRunIntent,
  takeChildRunIntent,
  type DispatchBrief,
  type ChildStartInput,
  type PlanExecutionContext,
} from "./protocol"
import type { LaunchSnapshot } from "@/agent/subagent-profile"
import { PlanProtocolError, planFilePath, readPlanFileSync } from "./schema"
import { RuntimeEvent } from "./runtime-event"
import { Blackboard } from "./blackboard"
import { ChildWorkspace, worktreeAdapter, type SnapshotLimits } from "./child-workspace"
import { terminateChild, type ChildTerminationRequest } from "./child-termination"
import { InstanceStore } from "@/project/instance-store"
import * as Log from "@jyycode-ai/core/util/log"
import { canDispatchSnapshot } from "./workspace-sweeper"
import { removeWorkspaceLeaseFile, WorkspaceLeaseStore } from "./workspace-lease"

const log = Log.create({ service: "plan" })

export function childWorkspaceFor(input: {
  session: Pick<Session.Info, "directory">
  projectInfo?: Project.Info
  worktree?: Worktree.Interface
  bridge: EffectBridgeShape
  snapshotLimits?: Partial<SnapshotLimits>
  snapshotExclude?: readonly string[]
  snapshotInclude?: readonly string[]
  workspaceBudget?: { softLimitBytes?: number; hardLimitBytes?: number }
}) {
  const projectInfo = input.projectInfo
  if (!projectInfo || (projectInfo.vcs === "git" && !input.worktree)) return undefined
  const isGit = projectInfo.vcs === "git"
  return new ChildWorkspace({
    project: {
      root: projectInfo.id === "global" ? input.session.directory : projectInfo.worktree,
      vcs: isGit ? "git" : "none",
    },
    runtimeRoot: path.join(Global.Path.data, isGit ? "worktree" : "plan-workspaces", String(projectInfo.id)),
    ...(isGit && input.worktree
      ? { worktree: worktreeAdapter({ service: input.worktree, run: input.bridge.promise }) }
      : {}),
    ...(input.snapshotLimits ? { snapshotLimits: input.snapshotLimits } : {}),
    ...(input.snapshotExclude ? { snapshotExclude: input.snapshotExclude } : {}),
    ...(input.snapshotInclude ? { snapshotInclude: input.snapshotInclude } : {}),
    ...(input.workspaceBudget ? { workspaceBudget: input.workspaceBudget } : {}),
  })
}

function workspaceRuntimeRoot(input: { projectInfo?: Project.Info }) {
  if (!input.projectInfo) return undefined
  return path.join(
    Global.Path.data,
    input.projectInfo.vcs === "git" ? "worktree" : "plan-workspaces",
    String(input.projectInfo.id),
  )
}

function workspaceLeaseStoreFor(input: { projectInfo?: Project.Info }) {
  const runtimeRoot = workspaceRuntimeRoot(input)
  return runtimeRoot ? new WorkspaceLeaseStore({ runtimeRoot }) : undefined
}

const Empty = Schema.Struct({})
const AnyObject = Schema.declare<unknown>((_u): _u is unknown => true)

/** The one public name used in model requests, prompts, results, and errors. */
export function modelFacingPlanToolName(id: string) {
  if (id === "Blackboard.reply") return "Blackboard_Reply"
  return id.replaceAll(".", "_")
}

const nonEmptyStringSchema: JSONSchema7 = { type: "string", minLength: 1 }
const positiveIntegerSchema: JSONSchema7 = { type: "integer", minimum: 1 }
const stepIdSchema: JSONSchema7 = { type: "string", pattern: "^s[1-9]\\d*$" }
const taskIdSchema: JSONSchema7 = { type: "string", pattern: "^s[1-9]\\d*_t[1-9]\\d*$" }

const taskInputSchema: JSONSchema7 = {
  type: "object",
  additionalProperties: false,
  required: ["title", "goal", "done_criteria"],
  properties: {
    title: nonEmptyStringSchema,
    goal: nonEmptyStringSchema,
    done_criteria: nonEmptyStringSchema,
    instructions: {
      ...nonEmptyStringSchema,
      description:
        "Child-facing instructions. Refer to files only with paths relative to the child's workspace_root (for example src/file.ts); never include absolute, parent-workspace, drive/UNC, home-expanded, environment-expanded, or file:// paths.",
    },
    output_path: nonEmptyStringSchema,
    no_progress_steps: positiveIntegerSchema,
    mode: {
      enum: ["standard", "candidate"],
      description:
        "Use candidate only when this Task is one of exactly 2-3 alternatives declared together in Plan_create or one Plan_update for a clean active Step; candidate output_path is assigned by the runtime.",
    },
  },
}

const stepInputSchema: JSONSchema7 = {
  type: "object",
  additionalProperties: false,
  required: ["title", "goal", "done_criteria"],
  properties: {
    title: nonEmptyStringSchema,
    goal: nonEmptyStringSchema,
    done_criteria: nonEmptyStringSchema,
    tasks: {
      type: "array",
      items: taskInputSchema,
      description:
        "Declare 3-10 independent parallel standard Tasks here (max 20); split every independent deliverable, module, investigation, or verification layer into its own Task, and prefer dispatching more subagents over merging work. For a candidate Step, include exactly 2-3 candidate Tasks together. The initial Step may declare them in Plan_create; a later clean active Step may initialize them with one Plan_update containing 2-3 candidate add_task operations.",
    },
  },
}

export const PLAN_CREATE_INPUT_SCHEMA: JSONSchema7 = {
  type: "object",
  additionalProperties: false,
  required: ["title", "goal", "steps"],
  properties: {
    title: { type: "string", minLength: 1, maxLength: 60 },
    goal: nonEmptyStringSchema,
    steps: {
      type: "array",
      minItems: 2,
      items: stepInputSchema,
      description:
        "Only steps[0] may contain Task details at creation. Put all currently parallel-ready standard Tasks (target 3-10, max 20) into steps[0].tasks; prefer splitting into more Tasks and dispatching more subagents. Later active Steps are expanded with one Plan_update containing all ready standard Tasks or one complete 2-3 candidate Task group.",
    },
  },
}

const updateOps: JSONSchema7[] = [
  {
    type: "object",
    additionalProperties: false,
    required: ["op", "fields"],
    properties: {
      op: { const: "edit_plan" },
      fields: {
        type: "object",
        additionalProperties: false,
        minProperties: 1,
        properties: {
          title: { type: "string", minLength: 1, maxLength: 60 },
          goal: nonEmptyStringSchema,
        },
      },
    },
  },
  {
    type: "object",
    additionalProperties: false,
    required: ["op", "step"],
    properties: {
      op: { const: "add_step" },
      after: stepIdSchema,
      step: {
        type: "object",
        additionalProperties: false,
        required: ["title", "goal", "done_criteria"],
        properties: {
          title: nonEmptyStringSchema,
          goal: nonEmptyStringSchema,
          done_criteria: nonEmptyStringSchema,
        },
      },
    },
  },
  {
    type: "object",
    additionalProperties: false,
    required: ["op", "stepId", "fields"],
    properties: {
      op: { const: "edit_step" },
      stepId: stepIdSchema,
      fields: {
        type: "object",
        additionalProperties: false,
        minProperties: 1,
        properties: {
          title: nonEmptyStringSchema,
          goal: nonEmptyStringSchema,
          done_criteria: nonEmptyStringSchema,
        },
      },
    },
  },
  {
    type: "object",
    additionalProperties: false,
    required: ["op", "stepId"],
    properties: { op: { const: "remove_step" }, stepId: stepIdSchema },
  },
  {
    type: "object",
    additionalProperties: false,
    required: ["op", "stepId", "task"],
    properties: { op: { const: "add_task" }, stepId: stepIdSchema, task: taskInputSchema },
  },
  {
    type: "object",
    additionalProperties: false,
    required: ["op", "stepId", "taskId", "fields"],
    properties: {
      op: { const: "edit_task" },
      stepId: stepIdSchema,
      taskId: taskIdSchema,
      fields: {
        type: "object",
        additionalProperties: false,
        minProperties: 1,
        properties: {
          title: nonEmptyStringSchema,
          goal: nonEmptyStringSchema,
          done_criteria: nonEmptyStringSchema,
          instructions: nonEmptyStringSchema,
          output_path: nonEmptyStringSchema,
          no_progress_steps: positiveIntegerSchema,
        },
      },
    },
  },
  {
    type: "object",
    additionalProperties: false,
    required: ["op", "stepId", "taskId"],
    properties: { op: { const: "remove_task" }, stepId: stepIdSchema, taskId: taskIdSchema },
  },
  {
    type: "object",
    additionalProperties: false,
    required: ["op", "stepId", "taskId", "reason"],
    properties: {
      op: { const: "reopen_task" },
      stepId: stepIdSchema,
      taskId: taskIdSchema,
      reason: nonEmptyStringSchema,
    },
  },
  {
    type: "object",
    additionalProperties: false,
    required: ["op", "stepId", "taskId", "to"],
    properties: {
      op: { const: "set_task_status" },
      stepId: stepIdSchema,
      taskId: taskIdSchema,
      to: { enum: ["pending", "running", "reported", "approved", "rejected", "dismissed"] },
    },
  },
  {
    type: "object",
    additionalProperties: false,
    required: ["op", "stepId", "taskId", "decision"],
    properties: {
      op: { const: "review_task" },
      stepId: stepIdSchema,
      taskId: taskIdSchema,
      decision: { enum: ["approve", "reject"] },
      feedback: nonEmptyStringSchema,
    },
    if: { properties: { decision: { const: "reject" } } },
    then: { required: ["feedback"] },
  },
  {
    type: "object",
    additionalProperties: false,
    required: ["op", "stepId", "selectedTaskId", "synthesisArtifact", "rationale"],
    properties: {
      op: { const: "select_candidate" },
      stepId: stepIdSchema,
      selectedTaskId: taskIdSchema,
      contributingTaskIds: { type: "array", uniqueItems: true, items: taskIdSchema },
      synthesisArtifact: nonEmptyStringSchema,
      rationale: nonEmptyStringSchema,
    },
  },
]

export const PLAN_UPDATE_INPUT_SCHEMA: JSONSchema7 = {
  type: "object",
  additionalProperties: false,
  required: ["revision", "ops"],
  properties: {
    revision: { type: "integer", minimum: 1 },
    ops: {
      type: "array",
      minItems: 1,
      maxItems: 50,
      items: { oneOf: updateOps },
      description:
        "add_task normally creates standard Tasks. A later clean active Step may initialize a candidate group only when this one call contains all 2-3 candidate add_task operations; dispatch the resulting group together.",
    },
  },
}

export const DISPATCH_INPUT_SCHEMA: JSONSchema7 = {
  type: "object",
  additionalProperties: false,
  required: ["taskIds", "role"],
  properties: {
    taskIds: {
      type: "array",
      minItems: 1,
      maxItems: 20,
      items: taskIdSchema,
      description:
        "Pass every ready standard Task ID from the current wave in this one call (max 20); never split a wave into batches. For a candidate Step, pass every candidate Task ID from the same Step in this one call; never dispatch candidates individually.",
    },
    role: { type: "string", minLength: 1, description: "Use an enabled role such as general." },
  },
}

const cancelSchema: JSONSchema7 = {
  type: "object",
  additionalProperties: false,
  required: ["taskIds"],
  properties: { taskIds: { type: "array", minItems: 1, maxItems: 20, items: taskIdSchema } },
}

const reportSchema: JSONSchema7 = {
  type: "object",
  additionalProperties: false,
  required: ["run_id", "status", "summary"],
  properties: {
    run_id: { type: "string", pattern: "^run__[A-Za-z0-9_-]+__s[1-9]\\d*_t[1-9]\\d*$" },
    status: { enum: ["done", "partial", "failed"] },
    summary: { type: "string", minLength: 1 },
    artifacts: { type: "array", items: nonEmptyStringSchema },
    issues: { type: "array", items: { type: "string" } },
  },
  if: { properties: { status: { const: "done" } } },
  then: { required: ["artifacts"] },
}

export const MERGE_APPLY_INPUT_SCHEMA: JSONSchema7 = {
  type: "object",
  additionalProperties: false,
  required: ["task_id"],
  properties: {
    task_id: taskIdSchema,
    paths: {
      type: "array",
      maxItems: 200,
      uniqueItems: true,
      items: { type: "string", minLength: 1 },
      description: "Optional workspace-relative narrowing scope; omit it to merge all baseline-relative child changes.",
    },
    resolutions: {
      type: "array",
      maxItems: 200,
      uniqueItems: true,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["path", "use"],
        properties: {
          path: { type: "string", minLength: 1 },
          use: { enum: ["main", "child"] },
        },
      },
      description:
        "Retry only after inspecting a conflict: use main for the edited parent file or child for an explicit replacement.",
    },
  },
}

export const MERGE_APPLY_DESCRIPTION =
  "主 Agent 在 review_task(approve) 后调用 Merge_apply({task_id}) 集成隔离 Task；正常调用只需 task_id。若返回 conflict，先检查 main_path 并编辑父 workspace，再用 resolutions:[{path,use:'main'|'child'}] 重试。工具只合并安全的非重叠变更，不附带文件内容或 secrets。"

const inboxSchema: JSONSchema7 = {
  type: "object",
  additionalProperties: false,
  properties: {
    mark_handled: { type: "array", items: { type: "string", minLength: 1 } },
  },
}

export const BLACKBOARD_INPUT_SCHEMA: JSONSchema7 = {
  type: "object",
  additionalProperties: false,
  properties: {
    message: nonEmptyStringSchema,
    kind: { enum: ["info", "risk", "blocker", "decision", "help"] },
    task_ids: { type: "array", uniqueItems: true, items: taskIdSchema },
    reply_to: nonEmptyStringSchema,
    attachments: { type: "array", items: nonEmptyStringSchema },
  },
}

function persistedRunId(session: Session.Info) {
  const rootID = session.parentID ?? session.id
  const plan = readPlanFileSync(planFilePath(session.directory, rootID))
  return plan?.steps.flatMap((step) => step.tasks).find((task) => task.dispatch?.child_session_id === session.id)
    ?.dispatch?.run_id
}

function runId(ctx: Tool.Context, session?: Session.Info) {
  const candidates = [
    ctx.extra?.run_id,
    ctx.extra?.runID,
    ctx.extra?.agentRunID,
    runIdForChildSession(ctx.sessionID),
    session ? persistedRunId(session) : undefined,
  ]
  return candidates.find((value): value is string => typeof value === "string" && value.length > 0)
}

function protocolContext(session: Session.Info, ctx: Tool.Context): PlanExecutionContext {
  return {
    workspaceRoot: session.directory,
    sessionId: session.id,
    mode: session.multiAgent === true ? "multi" : "single",
    agentDepth: session.agentDepth ?? 0,
    runId: runId(ctx, session),
  }
}

function jsonResult(tool: string, value: unknown) {
  return {
    title: modelFacingPlanToolName(tool),
    metadata: { protocol: "plan-v1" },
    output: JSON.stringify(value, null, 2),
  }
}

function getSession(sessions: Session.Interface, sessionID: Tool.Context["sessionID"]) {
  return sessions.get(sessionID).pipe(Effect.orDie)
}

function promptOps(ctx: Tool.Context) {
  const value = ctx.extra?.promptOps
  if (!value) throw new Error("Plan runtime requires promptOps")
  return value as TaskPromptOps
}

function requestToolCatalogRefresh(ctx: Tool.Context) {
  const request = ctx.extra?.requestToolCatalogRefresh
  if (typeof request === "function") request()
}

function wakeBlackboardRecipients(
  ctx: Tool.Context,
  board: Blackboard.Interface,
  message: Blackboard.Message,
  bridge: EffectBridgeShape,
) {
  const ops = ctx.extra?.promptOps as TaskPromptOps | undefined
  if (!ops) return Effect.void
  return Effect.gen(function* () {
    const recipients = yield* board.recipientsForMessage(message)
    bridge.fork(
      Effect.forEach(recipients, (recipient) =>
        ops
          .wake({
            sessionID: recipient.sessionID,
            kind: recipient.role === "main" ? "blackboard_agent_message" : "blackboard_direct_message",
            text:
              recipient.role === "main"
                ? "Blackboard 有新的子 Agent 消息。请调用 Blackboard 阅读全部当前 Step 消息；必要时可使用 Blackboard_Reply 回复。"
                : "Blackboard 收到与你的 Task 有关的新消息。请调用 Blackboard 阅读并处理；完成后继续当前任务。",
          })
          .pipe(Effect.ignore),
      ).pipe(Effect.asVoid),
    )
  })
}

function drainProtocolWakeups(
  protocol: PlanProtocol,
  ops: TaskPromptOps,
  bridge: EffectBridgeShape,
  sessionIDs: readonly string[],
  currentSessionID?: string,
) {
  const events = sessionIDs
    .filter((sessionID) => sessionID !== currentSessionID)
    .flatMap((sessionID) => protocol.drainWakeups(sessionID))
  bridge.fork(
    Effect.forEach(events, (event) =>
      ops
        .wake({
          sessionID: event.session_id as SessionID,
          kind: `plan_${event.type}`,
          text:
            event.type === "check_point"
              ? "候选流程已进入下一阶段。请先读取当前阶段要求，再继续候选任务。"
              : "候选流程有新的可处理事件。请先读取当前方案状态，再继续候选任务。",
        })
        .pipe(Effect.ignore),
    ).pipe(Effect.asVoid),
  )
  return Effect.void
}

function candidateChildSessionIDs(session: Session.Info) {
  const rootID = session.parentID ?? session.id
  const plan = readPlanFileSync(planFilePath(session.directory, rootID))
  return (
    plan?.steps
      .flatMap((step) => step.tasks)
      .filter((task) => task.mode === "candidate")
      .flatMap((task) => (task.dispatch?.child_session_id ? [task.dispatch.child_session_id] : [])) ?? []
  )
}

/** The only user-visible content in a child session's initial message. */
export function childTaskBrief(brief: DispatchBrief, role?: Pick<LaunchSnapshot, "prompt">) {
  const parts = [
    "## Instructions",
    brief.task_instructions?.trim() || "No additional instructions.",
    "",
    "## Current Task Goal",
    brief.goal.trim(),
    "",
    "## Working Directory",
    brief.workspace_root,
    "这是当前子任务的工作目录，可能是隔离 worktree、隔离 snapshot，也可能是显式 shared_compat。不要根据目录名称猜测关系；所有相对路径都相对于此目录解析，禁止在其外读写文件。",
  ]
  if (brief.previous_feedback) {
    parts.push(
      "",
      "## Previous Review Feedback",
      "这是一次审核打回后的重试：必须立即按照下面的反馈修改后再提交，不要等待额外的“打回事件”。",
      `- 反馈：${brief.previous_feedback.review_feedback.trim()}`,
      ...(brief.previous_feedback.issues.length > 0
        ? ["- 原有问题：", ...brief.previous_feedback.issues.map((issue) => `  - ${issue.trim()}`)]
        : []),
    )
  }
  const rolePrompt = role?.prompt.trim()
  if (rolePrompt) parts.push("", "## Role Instructions", rolePrompt)
  return parts.join("\n")
}

/** Full dispatch metadata is delivered in a synthetic message part. */
function childInitialBrief(brief: DispatchBrief) {
  const initialBrief = { ...brief }
  delete initialBrief.previous_feedback
  delete initialBrief.review_feedback_history
  return initialBrief
}

function childInternalTaskBrief(brief: DispatchBrief) {
  // Review feedback is delivered as a separate user prompt on retries. Keep
  // it out of the initial dispatch metadata so the child can distinguish the
  // original assignment from the revision request.
  const initialBrief = childInitialBrief(brief)
  const common = [
    "## 主 Agent 派发的任务简报",
    "",
    "```json",
    JSON.stringify(initialBrief, null, 2),
    "```",
    "",
    "不要创建或输出父方案。`workspace_root` 是当前子任务的工作目录，可能是隔离 worktree、隔离 snapshot，也可能是显式 shared_compat；`output_path` 已基于它解析为绝对路径。简报或指令中的相对路径一律相对于 `workspace_root`，禁止在其外读写文件。",
  ].join("\n")
  if (brief.mode !== "candidate")
    return [
      common,
      "## Standard execution",
      "先把产出写入 `output_path`，再调用 `Report`；status=done 时 artifacts 必须列出真实存在的文件。",
    ].join("\n\n")
  return [
    common,
    "## Candidate execution",
    "这是 candidate Task：先调用 Candidate_declare 一次；进入 cross_review 后用 Blackboard 读取并用 Blackboard_Reply 回复每个其他候选，再调用 Candidate_ready。",
    "主 Agent 调用 Candidate_begin 后独立完成方案，只调用 Candidate_submit 提交 proposal；不要调用 Report 或在 running 阶段调用 Blackboard，也不要用文件工具手写提案，运行时会把 proposal 写入 `output_path`。",
  ].join("\n\n")
}

export const BLACKBOARD_REPLY_INPUT_SCHEMA: JSONSchema7 = {
  type: "object",
  additionalProperties: false,
  required: ["message", "reply_to"],
  properties: {
    message: nonEmptyStringSchema,
    reply_to: nonEmptyStringSchema,
    kind: { enum: ["info", "risk", "blocker", "decision", "help"] },
    attachments: { type: "array", items: nonEmptyStringSchema },
  },
}

const candidateDeclareSchema: JSONSchema7 = {
  type: "object",
  additionalProperties: false,
  required: ["approach", "assumptions", "risks", "differentiator"],
  properties: {
    approach: nonEmptyStringSchema,
    assumptions: { type: "array", maxItems: 20, items: nonEmptyStringSchema },
    risks: { type: "array", maxItems: 20, items: nonEmptyStringSchema },
    differentiator: nonEmptyStringSchema,
  },
}

const candidateSubmitSchema: JSONSchema7 = {
  type: "object",
  additionalProperties: false,
  required: ["run_id", "status", "summary", "proposal"],
  properties: {
    run_id: { type: "string", pattern: "^run__[A-Za-z0-9_-]+__s[1-9]\\d*_t[1-9]\\d*$" },
    status: { enum: ["done", "partial", "failed"] },
    summary: nonEmptyStringSchema,
    proposal: nonEmptyStringSchema,
  },
}

export function childModelForRole(parentModel: Session.Info["model"], role: LaunchSnapshot) {
  const model = role.model ? Provider.parseModel(role.model) : parentModel
  if (!model) return undefined
  const sessionModel = "modelID" in model ? { id: model.modelID, providerID: model.providerID } : model
  return {
    ...sessionModel,
    ...(role.variant ? { variant: role.variant } : {}),
  }
}

/**
 * Resolve the child session model for a role, falling back to "follow the
 * main Agent" when the role's configured model is not usable (its provider is
 * not connected or the model does not exist). The fallback keeps the role's
 * thinking-depth override, matching the semantics of an unset role model.
 */
export async function resolveChildModel(
  run: <A, E, R>(effect: Effect.Effect<A, E, R>) => Promise<A>,
  parentModel: Session.Info["model"],
  role: LaunchSnapshot,
) {
  if (!role.model) return childModelForRole(parentModel, role)
  const parsed = Provider.parseModel(role.model)
  try {
    const available = await run(
      Provider.Service.use((provider) => provider.getModel(parsed.providerID, parsed.modelID)).pipe(
        Effect.map(() => true),
        Effect.catch(() => Effect.succeed(false)),
      ),
    )
    if (available) return childModelForRole(parentModel, role)
    log.warn("role model unavailable, falling back to parent model", {
      role: role.id,
      model: role.model,
      parent: parentModel ? `${parentModel.providerID}/${parentModel.id}` : undefined,
    })
    return childModelForRole(parentModel, { ...role, model: undefined })
  } catch (error) {
    // Never let the availability probe break dispatch; keep the configured model.
    log.error("role model availability check failed", { role: role.id, model: role.model, error })
    return childModelForRole(parentModel, role)
  }
}

export function childLaunchPrompt(brief: DispatchBrief, role: LaunchSnapshot) {
  return [
    childInternalTaskBrief(brief),
    "## Role instructions (launch only)",
    role.prompt.trim() || "No additional role instructions.",
  ].join("\n\n")
}

type RetryFeedback = { review_feedback: string; issues: string[] }

function formatRetryPrompt(feedback: RetryFeedback) {
  return [
    "## Revision Request",
    "The main Agent rejected the previous report. Apply this feedback to the existing work, then resubmit the corrected result with Report.",
    "",
    feedback.review_feedback.trim(),
    ...(feedback.issues.length > 0
      ? ["", "Reported issues:", ...feedback.issues.map((issue) => `- ${issue.trim()}`)]
      : []),
  ].join("\n")
}

/** User-visible prompts sent after the initial task prompt, one per review round. */
export function childRetryPrompts(brief: DispatchBrief) {
  const history = brief.review_feedback_history?.length
    ? brief.review_feedback_history
    : brief.previous_feedback
      ? [brief.previous_feedback]
      : []
  return history.map(formatRetryPrompt)
}

/** The latest retry prompt, retained as a convenient single-round helper. */
export function childRetryPrompt(brief: DispatchBrief) {
  return childRetryPrompts(brief).at(-1)
}

export function childLaunchParts(brief: DispatchBrief, role: LaunchSnapshot) {
  const initialBrief = childInitialBrief(brief)
  return [
    { type: "text" as const, text: childTaskBrief(initialBrief, role) },
    {
      type: "text" as const,
      text: childLaunchPrompt(brief, role),
      synthetic: true,
      metadata: { kind: "plan_dispatch_context" },
    },
  ]
}

function protocolFor(
  sessions: Session.Interface,
  bus: Bus.Interface,
  runtime: {
    bridge: EffectBridgeShape
    promptOps?: TaskPromptOps
    beforeReport?: (ctx: PlanExecutionContext) => Promise<void>
    beforeStepAdvance?: (ctx: PlanExecutionContext) => Promise<void>
    profiles?: () => Promise<readonly SubagentProfile[]>
    candidateBoard?: Blackboard.Interface
    childWorkspace?: ChildWorkspace
    disposeDirectory?: (directory: string) => Promise<void>
    leaseStore?: WorkspaceLeaseStore
  },
) {
  let protocol: PlanProtocol
  const runChild = (input: ChildStartInput, continuation: boolean) => {
    if (!runtime.promptOps) return
    const ops = runtime.promptOps
    registerChildRun(input.childSessionId, input.brief.run_id)
    if (input.brief.budget) registerChildBudget(input.childSessionId, input.brief.budget)
    if (continuation && input.workspace?.directory && input.workspace.mode !== "shared_compat" && runtime.leaseStore) {
      runtime.leaseStore.create({
        workspace_directory: input.workspace.directory,
        root_session_id: input.parentSessionId,
        task_id: input.taskId,
        run_id: input.brief.run_id,
        session_id: input.childSessionId,
      })
    }
    const heartbeat =
      input.workspace?.directory && input.workspace.mode !== "shared_compat" && runtime.leaseStore
        ? setInterval(() => {
            try {
              runtime.leaseStore!.heartbeat(input.workspace!.directory!, { sessionId: input.childSessionId })
            } catch {
              // A missing lease is safe to observe; the sweeper still checks
              // Session/Plan liveness before reclaiming the workspace.
            }
          }, 30_000)
        : undefined
    if (heartbeat && typeof heartbeat === "object" && "unref" in heartbeat) heartbeat.unref()
    const releaseLease = () => {
      if (heartbeat) clearInterval(heartbeat)
      if (input.workspace?.directory && input.workspace.mode !== "shared_compat") {
        if (runtime.leaseStore) runtime.leaseStore.remove(input.workspace.directory)
        else removeWorkspaceLeaseFile(input.workspace.directory)
      }
    }
    const settleAndNotify = (message?: string) =>
      Effect.gen(function* () {
        releaseLease()
        if (takeChildRunIntent(input.childSessionId)) return
        const budgetFailure = takeChildBudgetFailure(input.childSessionId)
        const outcome = yield* Effect.promise(() =>
          protocol.settleChildExit({
            workspaceRoot: planRootForRunId(input.brief.run_id) ?? input.brief.workspace_root,
            parentSessionId: input.parentSessionId,
            childSessionId: input.childSessionId,
            taskId: input.taskId,
            runId: input.brief.run_id,
          }),
        ).pipe(Effect.orElseSucceed(() => ({ settled: false, reason: "settle_failed" })))
        if (message === undefined && !budgetFailure && !outcome.settled) return
        const failureMessage =
          budgetFailure === "MAX_STEPS_BUDGET_EXCEEDED"
            ? "Child reached its step budget before submitting Report; this is not a wall-clock timeout."
            : budgetFailure === "DEADLINE_BUDGET_EXCEEDED"
              ? "Child exceeded its wall-clock execution deadline before submitting Report."
              : budgetFailure === "NO_PROGRESS_BUDGET_EXCEEDED"
                ? "Child stopped after exhausting its no-progress budget before submitting Report."
                : budgetFailure
                  ? `Child execution stopped: ${budgetFailure}.`
                  : undefined
        protocol.inbox.add({
          session_id: input.parentSessionId,
          task_id: input.taskId,
          run_id: input.brief.run_id,
          kind: "runtime_error",
          message: message ?? failureMessage ?? `Child stopped without Report for task ${input.taskId}.`,
          suggested_actions: ["Read Inbox", "repair the task and redispatch it"],
        })
        yield* ops
          .wake({
            sessionID: input.parentSessionId as SessionID,
            kind: "plan_child_runtime_error",
            text: `Child ${input.childSessionId} stopped while executing ${input.taskId}; inspect Plan and Inbox.`,
          })
          .pipe(Effect.ignore)
      })
    runtime.bridge.fork(
      Effect.gen(function* () {
        if (continuation) {
          const retryPrompt = childRetryPrompt(input.brief)
          if (!retryPrompt) throw new Error("A continued child task requires review feedback")
          yield* ops.prompt({
            sessionID: input.childSessionId as SessionID,
            agent: profileAgentName(input.role.id),
            noReply: true,
            parts: [{ type: "text", text: retryPrompt }],
          })
        } else {
          // Persist the visible initial task before entering the model loop.
          yield* ops.prompt({
            sessionID: input.childSessionId as SessionID,
            agent: profileAgentName(input.role.id),
            noReply: true,
            parts: childLaunchParts(input.brief, input.role),
          })
          for (const retryPrompt of childRetryPrompts(input.brief)) {
            yield* ops.prompt({
              sessionID: input.childSessionId as SessionID,
              agent: profileAgentName(input.role.id),
              noReply: true,
              parts: [{ type: "text", text: retryPrompt }],
            })
          }
        }
        yield* ops.loop({ sessionID: input.childSessionId as SessionID })
      }).pipe(
        Effect.catchCause((cause) => settleAndNotify(`Child start or execution failed: ${Cause.pretty(cause)}`)),
        Effect.flatMap(() => settleAndNotify()),
        Effect.ensuring(Effect.sync(() => clearChildBudget(input.childSessionId))),
      ),
    )
  }
  protocol = new PlanProtocol({
    eventSink: (event) => {
      runtime.bridge.fork(bus.publish(RuntimeEvent, event).pipe(Effect.ignore))
    },
    profiles: runtime.profiles,
    children: {
      async create(input) {
        const run = runtime.bridge.promise
        const parent = await run(sessions.get(input.parentSessionId as SessionID).pipe(Effect.orDie))
        const child = await run(
          sessions.create({
            parentID: parent.id,
            title: `Plan task ${input.taskId}`,
            agent: profileAgentName(input.role.id),
            model: await resolveChildModel(run, parent.model, input.role),
            permission: parent.permission,
            workspaceID: parent.workspaceID,
            directory:
              (input.workspace?.mode === "worktree" || input.workspace?.mode === "snapshot") &&
              input.workspace.directory
                ? input.workspace.directory
                : parent.directory,
          }),
        )
        if (input.workspace?.directory && input.workspace.mode !== "shared_compat" && runtime.leaseStore) {
          runtime.leaseStore.create({
            workspace_directory: input.workspace.directory,
            root_session_id: input.parentSessionId,
            task_id: input.taskId,
            run_id: input.brief.run_id,
            session_id: child.id,
          })
        }
        return child.id
      },
      async start(input) {
        runChild(input, false)
        return
      },
      async resume(input) {
        runChild(input, true)
      },
      async terminate(sessionId, request?: ChildTerminationRequest) {
        const run = runtime.bridge.promise
        if (!runtime.promptOps) throw new Error("Plan runtime requires promptOps for child termination")
        if (!runtime.disposeDirectory) throw new Error("Plan runtime requires instanceStore for child termination")
        const result = await terminateChild(
          { sessionId, request },
          {
            markIntent: () => {
              // The coordinator owns termination, so the dispatch watcher must
              // not race it with an automatic child-exit settle.
              markChildRunIntent(sessionId, "terminate")
            },
            cancel: () => run(runtime.promptOps!.cancel(sessionId as SessionID)),
            status: () => run(runtime.promptOps!.status(sessionId as SessionID)),
            disposeDirectory: (directory) => runtime.disposeDirectory!(directory),
            archive: () => run(sessions.setArchived({ sessionID: sessionId as SessionID, time: Date.now() })),
          },
        )
        if (request?.workspace?.directory && result?.state === "stopped") {
          if (runtime.leaseStore) runtime.leaseStore.remove(request.workspace.directory)
          else removeWorkspaceLeaseFile(request.workspace.directory)
        }
        return result
      },
    },
    beforeReport: runtime.beforeReport,
    beforeStepAdvance: runtime.beforeStepAdvance,
    candidateBoard: runtime.candidateBoard
      ? {
          postCandidateDeclaration: (input) =>
            runtime.bridge.promise(
              runtime.candidateBoard!.postCandidateDeclaration({ ...input, sessionID: input.sessionID as SessionID }),
            ),
          candidateDeclarations: (input) =>
            runtime.bridge.promise(
              runtime.candidateBoard!.candidateDeclarations({
                ...input,
                rootSessionID: input.rootSessionID as SessionID,
              }),
            ),
          candidatePeerReplyCoverage: (input) =>
            runtime.bridge.promise(
              runtime.candidateBoard!.candidatePeerReplyCoverage({
                ...input,
                rootSessionID: input.rootSessionID as SessionID,
              }),
            ),
          candidateParticipants: (input) =>
            runtime.bridge.promise(
              runtime.candidateBoard!.candidateParticipants({
                ...input,
                rootSessionID: input.rootSessionID as SessionID,
              }),
            ),
        }
      : undefined,
    childWorkspace: runtime.childWorkspace,
  })
  return protocol
}

export const PlanReadTool = Tool.define(
  "Plan.read",
  Effect.gen(function* () {
    const sessions = yield* Session.Service
    const bus = yield* Bus.Service
    return {
      description: "读取当前主 session 的持久化方案和进度。",
      parameters: Empty,
      catalog: {
        category: "other" as const,
        mutability: "read" as const,
        risk: "low" as const,
        detail: "standard" as const,
      },
      execute: (_input: {}, ctx: Tool.Context) =>
        Effect.gen(function* () {
          const bridge = yield* EffectBridge.make()
          const protocol = protocolFor(sessions, bus, { bridge })
          const session = yield* getSession(sessions, ctx.sessionID)
          return jsonResult("Plan.read", yield* Effect.promise(() => protocol.read(protocolContext(session, ctx))))
        }),
    }
  }),
)

export const InboxTool = Tool.define(
  "Inbox",
  Effect.gen(function* () {
    const sessions = yield* Session.Service
    const bus = yield* Bus.Service
    return {
      description: "读取主 session 的异常 Inbox，并可标记已处理条目。",
      parameters: AnyObject,
      jsonSchema: inboxSchema,
      catalog: {
        category: "other" as const,
        mutability: "write" as const,
        risk: "low" as const,
        detail: "standard" as const,
      },
      execute: (input: unknown, ctx: Tool.Context) =>
        Effect.gen(function* () {
          const bridge = yield* EffectBridge.make()
          const protocol = protocolFor(sessions, bus, { bridge })
          const session = yield* getSession(sessions, ctx.sessionID)
          return jsonResult(
            "Inbox",
            yield* Effect.promise(() => protocol.readInbox(protocolContext(session, ctx), input)),
          )
        }),
    }
  }),
)

export const BlackboardTool = Tool.define(
  "Blackboard",
  Effect.gen(function* () {
    return {
      description:
        "无参读取当前 Step 的 Task 与新消息；用 message 发布简洁的发现、依赖、交接、决策、风险、阻塞或求助，不要发布心跳或重复的普通进度。",
      parameters: AnyObject,
      jsonSchema: BLACKBOARD_INPUT_SCHEMA,
      catalog: {
        category: "communication" as const,
        mutability: "write" as const,
        risk: "low" as const,
        detail: "standard" as const,
      },
      execute: (input: unknown, ctx: Tool.Context) =>
        Effect.gen(function* () {
          const board = yield* Blackboard.Service
          const bridge = yield* EffectBridge.make()
          const value =
            input && typeof input === "object" && !Array.isArray(input) ? (input as Record<string, unknown>) : {}
          if (typeof value.message === "string") {
            const message = yield* board.postAgent({
              sessionID: ctx.sessionID,
              message: value.message,
              kind: typeof value.kind === "string" ? (value.kind as Blackboard.BlackboardKind) : undefined,
              taskIDs: Array.isArray(value.task_ids)
                ? value.task_ids.filter((item): item is string => typeof item === "string")
                : undefined,
              replyTo: typeof value.reply_to === "string" ? value.reply_to : undefined,
              attachments: Array.isArray(value.attachments)
                ? value.attachments.filter((item): item is string => typeof item === "string")
                : undefined,
            })
            requestToolCatalogRefresh(ctx)
            yield* wakeBlackboardRecipients(ctx, board, message, bridge)
            return jsonResult("Blackboard", message)
          }
          const isMissingBlackboardState = (error: unknown) => {
            if (error instanceof Blackboard.BlackboardError)
              return error.code === "PLAN_NOT_FOUND" || error.code === "NO_CURRENT_STEP"
            if (!error || typeof error !== "object") return false
            const code = "code" in error ? error.code : undefined
            const message = "message" in error ? error.message : undefined
            return (
              code === "PLAN_NOT_FOUND" ||
              code === "NO_CURRENT_STEP" ||
              (typeof message === "string" && message.includes("plan.json"))
            )
          }
          const emptyBlackboardSnapshot = () =>
            Effect.succeed({
              rootSessionID: ctx.sessionID,
              stepID: "",
              tasks: [],
              messages: [],
              remaining: 0,
              status: "plan_not_created" as const,
            })
          const snapshot = yield* board.readAgent(ctx.sessionID).pipe(
            Effect.catchIf(isMissingBlackboardState, emptyBlackboardSnapshot),
            Effect.catchDefect((error) =>
              isMissingBlackboardState(error) ? emptyBlackboardSnapshot() : Effect.die(error),
            ),
          )
          return jsonResult("Blackboard", snapshot)
        }).pipe(Effect.provide(Blackboard.defaultLayer)),
    }
  }),
)

export const BlackboardReplyTool = Tool.define(
  "Blackboard.reply",
  Effect.gen(function* () {
    return {
      description: "回复 Blackboard 的一条顶层消息。必须提供 reply_to 和 message；读取消息请使用 Blackboard。",
      parameters: AnyObject,
      jsonSchema: BLACKBOARD_REPLY_INPUT_SCHEMA,
      catalog: {
        category: "communication" as const,
        mutability: "write" as const,
        risk: "low" as const,
        detail: "standard" as const,
      },
      execute: (input: unknown, ctx: Tool.Context) =>
        Effect.gen(function* () {
          const board = yield* Blackboard.Service
          const bridge = yield* EffectBridge.make()
          const value =
            input && typeof input === "object" && !Array.isArray(input) ? (input as Record<string, unknown>) : {}
          if (typeof value.message !== "string" || typeof value.reply_to !== "string")
            throw new PlanProtocolError({
              code: "SCHEMA_VALIDATION",
              message: "Blackboard_Reply requires message and reply_to",
              hint: "提供要回复的顶层消息 ID 与回复正文",
            })
          const message = yield* board.postAgent({
            sessionID: ctx.sessionID,
            message: value.message,
            replyTo: value.reply_to,
            kind: typeof value.kind === "string" ? (value.kind as Blackboard.BlackboardKind) : undefined,
            attachments: Array.isArray(value.attachments)
              ? value.attachments.filter((item): item is string => typeof item === "string")
              : undefined,
          })
          requestToolCatalogRefresh(ctx)
          yield* wakeBlackboardRecipients(ctx, board, message, bridge)
          return jsonResult("Blackboard.reply", message)
        }).pipe(Effect.provide(Blackboard.defaultLayer)),
    }
  }),
)

export const PlanCreateTool = Tool.define(
  "Plan.create",
  Effect.gen(function* () {
    const sessions = yield* Session.Service
    const bus = yield* Bus.Service
    return {
      description: "Child-agent wall-clock timeout is runtime-owned and fixed at 30 minutes; do not include timeout_ms. " +
        "创建当前主 session 的 plan.json；后续阶段只建立骨架，细节用 Plan_update 展开。按可并行性检查拆分，默认放 3-10 个可并行的 standard Task（上限 20 个）；能拆就拆，优先多派子 Agent。需要候选比较时，在 Plan_create 或后续 clean active Step 的一次 Plan_update 中完整放入 2-3 个 mode=candidate Task，运行时会自动创建 candidate_discussion 和隔离 proposal 路径。",
      parameters: AnyObject,
      jsonSchema: PLAN_CREATE_INPUT_SCHEMA,
      catalog: {
        category: "other" as const,
        mutability: "write" as const,
        risk: "medium" as const,
        detail: "standard" as const,
      },
      execute: (input: unknown, ctx: Tool.Context) =>
        Effect.gen(function* () {
          const bridge = yield* EffectBridge.make()
          const protocol = protocolFor(sessions, bus, { bridge })
          const session = yield* getSession(sessions, ctx.sessionID)
          const result = yield* Effect.promise(() => protocol.create(protocolContext(session, ctx), input))
          if (result.ok) requestToolCatalogRefresh(ctx)
          return jsonResult("Plan.create", result)
        }),
    }
  }),
)

export const PlanUpdateTool = Tool.define(
  "Plan.update",
  Effect.gen(function* () {
    const sessions = yield* Session.Service
    const bus = yield* Bus.Service
    return {
      description: "Child-agent wall-clock timeout is runtime-owned and fixed at 30 minutes; timeout_ms is not accepted. " +
        "以 revision 乐观锁原子修改方案、展开标准任务、推进单智能体状态或审核子 Agent 汇报。后续 active Step 可在一次调用中用 2-3 个 candidate add_task 初始化候选组；不能向已有 candidate Step 追加或混入 standard Task。",
      parameters: AnyObject,
      jsonSchema: PLAN_UPDATE_INPUT_SCHEMA,
      catalog: {
        category: "other" as const,
        mutability: "write" as const,
        risk: "medium" as const,
        detail: "advanced" as const,
      },
      execute: (input: unknown, ctx: Tool.Context) =>
        Effect.gen(function* () {
          const bridge = yield* EffectBridge.make()
          const board = yield* Blackboard.Service
          const session = yield* getSession(sessions, ctx.sessionID)
          const projectService = yield* Effect.serviceOption(Project.Service)
          const worktreeService = yield* Effect.serviceOption(Worktree.Service)
          const worktree = Option.getOrUndefined(worktreeService)
          const projectInfo = Option.isSome(projectService)
            ? yield* Effect.promise(() => bridge.promise(projectService.value.get(session.projectID)))
            : undefined
          const childWorkspace = childWorkspaceFor({ session, projectInfo, worktree, bridge })
          const leaseStore = workspaceLeaseStoreFor({ projectInfo })
          const disposeDirectory = (directory: string) =>
            bridge.promise(InstanceStore.Service.use((store) => store.disposeDirectory(directory)))
          const protocol = protocolFor(sessions, bus, {
            bridge,
            promptOps: promptOps(ctx),
            beforeStepAdvance: async (main) => {
              const unread = await bridge.promise(board.unreadForMain(main.sessionId as SessionID))
              if (unread > 0)
                throw new PlanProtocolError({
                  code: "BLACKBOARD_UNREAD",
                  message: `进入下一 Step 前必须处理当前 Step 的 ${unread} 条 Blackboard 消息`,
                  hint: "先无参调用 Blackboard，阅读并处理全部当前 Step 消息后，用同一 revision 重试 Plan_update",
                  retryable: true,
                })
            },
            childWorkspace,
            disposeDirectory,
            leaseStore,
          })
          const result = yield* Effect.promise(() => protocol.update(protocolContext(session, ctx), input))
          if (result.ok) requestToolCatalogRefresh(ctx)
          return jsonResult("Plan.update", result)
        }).pipe(Effect.provide(Blackboard.defaultLayer)),
    }
  }),
)

export const DispatchDispatchTool = Tool.define(
  "Dispatch.dispatch",
  Effect.gen(function* () {
    const sessions = yield* Session.Service
    const bus = yield* Bus.Service
    const config = yield* Config.Service
    return {
      description: "Child-agent wall-clock timeout is runtime-owned and fixed at 30 minutes; this tool has no timeout control. " +
        "在多智能体模式把 pending/rejected 任务派给指定角色。必须选择一个当前启用的 role；如果 taskIds 中包含 candidate Task，必须在一次调用中包含该 Step 的全部 2-3 个候选 ID。",
      parameters: Schema.Struct({ taskIds: Schema.Array(Schema.String), role: Schema.String }),
      jsonSchema: DISPATCH_INPUT_SCHEMA,
      catalog: {
        category: "subagent" as const,
        mutability: "execute" as const,
        risk: "high" as const,
        detail: "advanced" as const,
      },
      execute: (input: { taskIds: string[]; role: string }, ctx: Tool.Context) =>
        Effect.gen(function* () {
          const bridge = yield* EffectBridge.make()
          const session = yield* getSession(sessions, ctx.sessionID)
          const runtimeConfig = yield* Effect.promise(() => bridge.promise(config.get()))
          const projectService = yield* Effect.serviceOption(Project.Service)
          const worktreeService = yield* Effect.serviceOption(Worktree.Service)
          const worktree = Option.getOrUndefined(worktreeService)
          const projectInfo = Option.isSome(projectService)
            ? yield* Effect.promise(() => bridge.promise(projectService.value.get(session.projectID)))
            : undefined
          const childWorkspace = childWorkspaceFor({
            session,
            projectInfo,
            worktree,
            bridge,
            snapshotLimits: runtimeConfig.snapshot_limits
              ? {
                  ...(runtimeConfig.snapshot_limits.max_file_bytes !== undefined
                    ? { maxFileBytes: runtimeConfig.snapshot_limits.max_file_bytes }
                    : {}),
                  ...(runtimeConfig.snapshot_limits.max_total_bytes !== undefined
                    ? { maxTotalBytes: runtimeConfig.snapshot_limits.max_total_bytes }
                    : {}),
                  ...(runtimeConfig.snapshot_limits.max_file_count !== undefined
                    ? { maxFileCount: runtimeConfig.snapshot_limits.max_file_count }
                    : {}),
                }
              : undefined,
            snapshotExclude: runtimeConfig.snapshot_limits?.exclude,
            snapshotInclude: runtimeConfig.snapshot_limits?.include,
            workspaceBudget: runtimeConfig.snapshot_limits
              ? {
                  softLimitBytes: runtimeConfig.snapshot_limits.runtime_soft_limit_bytes,
                  hardLimitBytes: runtimeConfig.snapshot_limits.runtime_hard_limit_bytes,
                }
              : undefined,
          })
          const leaseStore = workspaceLeaseStoreFor({ projectInfo })
          if (
            childWorkspace?.capability() === "snapshot" &&
            leaseStore &&
            !(yield* Effect.promise(() => canDispatchSnapshot(leaseStore.runtimeRoot)))
          ) {
            throw new PlanProtocolError({
              code: "DISPATCH_UNAVAILABLE",
              message: "runtime workspace hard limit reached; snapshot dispatch is temporarily refused",
              hint: "清理已完成或失败的 workspace 后重试，active lease 不会被自动删除。",
              retryable: true,
            })
          }
          const disposeDirectory = (directory: string) =>
            bridge.promise(InstanceStore.Service.use((store) => store.disposeDirectory(directory)))
          const protocol = protocolFor(sessions, bus, {
            bridge,
            promptOps: promptOps(ctx),
            childWorkspace,
            disposeDirectory,
            leaseStore,
            profiles: async () => enabledProfiles(resolveProfiles(runtimeConfig.subagents?.profiles)),
          })
          const result = yield* Effect.promise(() => protocol.dispatch(protocolContext(session, ctx), input))
          // A failed dispatch still settles the task as rejected and records
          // an Inbox item. Invalidate this turn's tool snapshot as well, so
          // batched/replayed Dispatch_dispatch calls cannot retry stale input
          // in a loop before the next model turn can recover the task.
          requestToolCatalogRefresh(ctx)
          return jsonResult("Dispatch.dispatch", result)
        }),
    }
  }),
)

export const DispatchRolesTool = Tool.define(
  "Dispatch.roles",
  Effect.gen(function* () {
    const config = yield* Config.Service
    return {
      description:
        "List every currently enabled sub-agent role available to Dispatch_dispatch, including its ID, name, description, model, and thinking depth.",
      parameters: Empty,
      jsonSchema: { type: "object", additionalProperties: false } satisfies JSONSchema7,
      catalog: {
        category: "subagent" as const,
        mutability: "read" as const,
        risk: "low" as const,
        detail: "standard" as const,
      },
      execute: (_input: {}, _ctx: Tool.Context) =>
        Effect.gen(function* () {
          const profiles = enabledProfiles(resolveProfiles((yield* config.get()).subagents?.profiles))
          return jsonResult("Dispatch.roles", {
            count: profiles.length,
            roles: profiles.map((profile) => ({
              id: profile.id,
              name: profile.name,
              description: profile.description,
              model: profile.model ?? null,
              variant: profile.variant ?? null,
            })),
          })
        }),
    }
  }),
)

export const DispatchCancelTool = Tool.define(
  "Dispatch.cancel",
  Effect.gen(function* () {
    const sessions = yield* Session.Service
    const bus = yield* Bus.Service
    return {
      description:
        "取消多智能体任务并终止其子 session；已取消任务可重复调用，子 session 清理失败会在结果中返回 termination_errors。",
      parameters: Schema.Struct({ taskIds: Schema.Array(Schema.String) }),
      jsonSchema: cancelSchema,
      catalog: {
        category: "subagent" as const,
        mutability: "execute" as const,
        risk: "high" as const,
        detail: "advanced" as const,
      },
      execute: (input: { taskIds: string[] }, ctx: Tool.Context) =>
        Effect.gen(function* () {
          const bridge = yield* EffectBridge.make()
          const session = yield* getSession(sessions, ctx.sessionID)
          const projectService = yield* Effect.serviceOption(Project.Service)
          const worktreeService = yield* Effect.serviceOption(Worktree.Service)
          const worktree = Option.getOrUndefined(worktreeService)
          const projectInfo = Option.isSome(projectService)
            ? yield* Effect.promise(() => bridge.promise(projectService.value.get(session.projectID)))
            : undefined
          const childWorkspace = childWorkspaceFor({ session, projectInfo, worktree, bridge })
          const leaseStore = workspaceLeaseStoreFor({ projectInfo })
          const disposeDirectory = (directory: string) =>
            bridge.promise(InstanceStore.Service.use((store) => store.disposeDirectory(directory)))
          const protocol = protocolFor(sessions, bus, {
            bridge,
            promptOps: promptOps(ctx),
            childWorkspace,
            disposeDirectory,
            leaseStore,
          })
          const result = yield* Effect.promise(() => protocol.cancel(protocolContext(session, ctx), input.taskIds))
          if (result.ok) requestToolCatalogRefresh(ctx)
          return jsonResult("Dispatch.cancel", result)
        }),
    }
  }),
)

export const CandidateDeclareTool = Tool.define(
  "Candidate.declare",
  Effect.gen(function* () {
    const sessions = yield* Session.Service
    const bus = yield* Bus.Service
    return {
      description: "在候选讨论的 declaring 阶段提交一次盲声明。",
      parameters: AnyObject,
      jsonSchema: candidateDeclareSchema,
      catalog: {
        category: "communication" as const,
        mutability: "write" as const,
        risk: "low" as const,
        detail: "standard" as const,
      },
      execute: (input: unknown, ctx: Tool.Context) =>
        Effect.gen(function* () {
          const board = yield* Blackboard.Service
          const bridge = yield* EffectBridge.make()
          const ops = promptOps(ctx)
          const session = yield* getSession(sessions, ctx.sessionID)
          const protocol = protocolFor(sessions, bus, { bridge, candidateBoard: board })
          const result = yield* Effect.promise(() => protocol.candidateDeclare(protocolContext(session, ctx), input))
          if (result.ok) requestToolCatalogRefresh(ctx)
          yield* drainProtocolWakeups(protocol, ops, bridge, candidateChildSessionIDs(session), session.id)
          return jsonResult("Candidate.declare", result)
        }).pipe(Effect.provide(Blackboard.defaultLayer)),
    }
  }),
)

export const CandidateReadyTool = Tool.define(
  "Candidate.ready",
  Effect.gen(function* () {
    const sessions = yield* Session.Service
    const bus = yield* Bus.Service
    return {
      description: "确认已回复每位其他候选的顶层声明。",
      parameters: Empty,
      jsonSchema: { type: "object", additionalProperties: false } satisfies JSONSchema7,
      catalog: {
        category: "communication" as const,
        mutability: "write" as const,
        risk: "low" as const,
        detail: "standard" as const,
      },
      execute: (_input: {}, ctx: Tool.Context) =>
        Effect.gen(function* () {
          const board = yield* Blackboard.Service
          const bridge = yield* EffectBridge.make()
          const ops = promptOps(ctx)
          const session = yield* getSession(sessions, ctx.sessionID)
          const protocol = protocolFor(sessions, bus, { bridge, candidateBoard: board })
          const result = yield* Effect.promise(() => protocol.candidateReady(protocolContext(session, ctx), {}))
          if (result.ok) requestToolCatalogRefresh(ctx)
          yield* drainProtocolWakeups(protocol, ops, bridge, session.parentID ? [session.parentID] : [])
          return jsonResult("Candidate.ready", result)
        }).pipe(Effect.provide(Blackboard.defaultLayer)),
    }
  }),
)

export const CandidateBeginTool = Tool.define(
  "Candidate.begin",
  Effect.gen(function* () {
    const sessions = yield* Session.Service
    const bus = yield* Bus.Service
    return {
      description: "由根会话显式开始候选的独立执行阶段。",
      parameters: Empty,
      jsonSchema: { type: "object", additionalProperties: false } satisfies JSONSchema7,
      catalog: {
        category: "subagent" as const,
        mutability: "execute" as const,
        risk: "medium" as const,
        detail: "advanced" as const,
      },
      execute: (_input: {}, ctx: Tool.Context) =>
        Effect.gen(function* () {
          const bridge = yield* EffectBridge.make()
          const ops = promptOps(ctx)
          const session = yield* getSession(sessions, ctx.sessionID)
          const protocol = protocolFor(sessions, bus, { bridge })
          const result = yield* Effect.promise(() => protocol.candidateBegin(protocolContext(session, ctx), {}))
          if (result.ok) requestToolCatalogRefresh(ctx)
          yield* drainProtocolWakeups(protocol, ops, bridge, candidateChildSessionIDs(session))
          return jsonResult("Candidate.begin", result)
        }),
    }
  }),
)

export const CandidateSubmitTool = Tool.define(
  "Candidate.submit",
  Effect.gen(function* () {
    const sessions = yield* Session.Service
    const bus = yield* Bus.Service
    return {
      description: "把候选方案写入服务端隔离提案并提交候选报告。",
      parameters: AnyObject,
      jsonSchema: candidateSubmitSchema,
      catalog: {
        category: "subagent" as const,
        mutability: "write" as const,
        risk: "medium" as const,
        detail: "standard" as const,
      },
      execute: (input: unknown, ctx: Tool.Context) =>
        Effect.gen(function* () {
          const bridge = yield* EffectBridge.make()
          const ops = promptOps(ctx)
          const session = yield* getSession(sessions, ctx.sessionID)
          const protocol = protocolFor(sessions, bus, { bridge })
          const result = yield* Effect.promise(() => protocol.candidateSubmit(protocolContext(session, ctx), input))
          if (result.ok) requestToolCatalogRefresh(ctx)
          yield* drainProtocolWakeups(protocol, ops, bridge, session.parentID ? [session.parentID] : [])
          return jsonResult("Candidate.submit", result)
        }),
    }
  }),
)

export const ReportTool = Tool.define(
  "Report",
  Effect.gen(function* () {
    const sessions = yield* Session.Service
    const bus = yield* Bus.Service
    return {
      description: "子 session 唯一的任务汇报入口；先写入产出文件，再提交 done/partial/failed 汇报。",
      parameters: AnyObject,
      jsonSchema: reportSchema,
      catalog: {
        category: "subagent" as const,
        mutability: "write" as const,
        risk: "medium" as const,
        detail: "standard" as const,
      },
      execute: (input: unknown, ctx: Tool.Context) =>
        Effect.gen(function* () {
          const bridge = yield* EffectBridge.make()
          const session = yield* getSession(sessions, ctx.sessionID)
          const ops = promptOps(ctx)
          const board = yield* Blackboard.Service
          const disposeDirectory = (directory: string) =>
            bridge.promise(InstanceStore.Service.use((store) => store.disposeDirectory(directory)))
          const protocol = protocolFor(sessions, bus, {
            bridge,
            promptOps: ops,
            disposeDirectory,
            beforeReport: async (child) => {
              try {
                await bridge.promise(board.assertReportReady(child.sessionId as SessionID))
              } catch {
                throw new PlanProtocolError({
                  code: "BLACKBOARD_UNREAD",
                  message: "Report 前必须读取 Blackboard",
                  hint: "先无参调用 Blackboard，处理新消息后用同一 run_id 重试 Report",
                  retryable: true,
                })
              }
            },
          })
          const result = yield* Effect.promise(() => protocol.report(protocolContext(session, ctx), input))
          if (result.ok) removeWorkspaceLeaseFile(session.directory)
          if (result.ok) requestToolCatalogRefresh(ctx)
          const effectiveRunId = runId(ctx)
          const parentSessionId = effectiveRunId ? parentSessionIdForRunId(effectiveRunId) : undefined
          if (result.ok && parentSessionId) {
            bridge.fork(
              ops
                .wake({
                  sessionID: parentSessionId as SessionID,
                  kind: "plan_report_arrived",
                  text: `子 Agent 已提交 ${effectiveRunId} 的 Report（${result.review}）。先调用 Plan_read，再审核汇报或处理 Inbox。`,
                })
                .pipe(Effect.ignore),
            )
          }
          return jsonResult("Report", result)
        }).pipe(Effect.provide(Blackboard.defaultLayer)),
    }
  }),
)

export const MergeApplyTool = Tool.define(
  "Merge.apply",
  Effect.gen(function* () {
    const sessions = yield* Session.Service
    const bus = yield* Bus.Service
    return {
      description: MERGE_APPLY_DESCRIPTION,
      parameters: AnyObject,
      jsonSchema: MERGE_APPLY_INPUT_SCHEMA,
      catalog: {
        category: "subagent" as const,
        mutability: "write" as const,
        risk: "high" as const,
        detail: "advanced" as const,
      },
      execute: (input: unknown, ctx: Tool.Context) =>
        Effect.gen(function* () {
          const bridge = yield* EffectBridge.make()
          const session = yield* getSession(sessions, ctx.sessionID)
          const projectService = yield* Effect.serviceOption(Project.Service)
          const worktreeService = yield* Effect.serviceOption(Worktree.Service)
          const worktree = Option.getOrUndefined(worktreeService)
          const projectInfo = Option.isSome(projectService)
            ? yield* Effect.promise(() => bridge.promise(projectService.value.get(session.projectID)))
            : undefined
          const childWorkspace = childWorkspaceFor({ session, projectInfo, worktree, bridge })
          const disposeDirectory = (directory: string) =>
            bridge.promise(InstanceStore.Service.use((store) => store.disposeDirectory(directory)))
          const protocol = protocolFor(sessions, bus, {
            bridge,
            promptOps: promptOps(ctx),
            childWorkspace,
            disposeDirectory,
          })
          const result = yield* Effect.promise(() => protocol.merge(protocolContext(session, ctx), input))
          if (result.ok) requestToolCatalogRefresh(ctx)
          return jsonResult("Merge.apply", result)
        }),
    }
  }),
)

export const PlanProtocolTools = [
  PlanReadTool,
  InboxTool,
  BlackboardTool,
  BlackboardReplyTool,
  PlanCreateTool,
  PlanUpdateTool,
  DispatchDispatchTool,
  DispatchRolesTool,
  DispatchCancelTool,
  CandidateDeclareTool,
  CandidateReadyTool,
  CandidateBeginTool,
  CandidateSubmitTool,
  ReportTool,
  MergeApplyTool,
] as const

export const PLAN_TOOL_IDS = new Set<string>(PlanProtocolTools.map((tool) => tool.id))

export * as PlanTools from "./tools"
