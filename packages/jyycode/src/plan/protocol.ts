import fs from "node:fs"
import crypto from "node:crypto"
import path from "node:path"
import {
  defaultProfiles,
  enabledProfiles,
  launchSnapshot,
  profileByID,
  profileSnapshot,
  type LaunchSnapshot,
  type SubagentProfile,
} from "@/agent/subagent-profile"
import {
  ERROR_CODES,
  PlanProtocolError,
  clonePlan,
  isStepComplete,
  mergeStatus,
  planDirectory,
  planFilePath,
  responseFromError,
  type CreatePlanInput,
  type CreateStepInput,
  type CreateTaskInput,
  type DispatchRecord,
  type MergeRecord,
  type MergeResolution,
  type PlanFile,
  type PlanTaskMode,
  type PlanStep,
  type PlanTask,
  type PlanUpdateInput,
  type PlanUpdateOp,
  type ProtocolResponse,
  type ReportRecord,
  type ReportStatus,
  type TaskStatus,
} from "./schema"
import {
  defaultPlanEvents,
  defaultPlanInbox,
  defaultWakeupQueue,
  PlanEventHub,
  PlanInbox,
  WakeupQueue,
  type WakeupEvent,
} from "./events"
import { projectPlanSnapshot, type ActivityState, type PlanSnapshot } from "./snapshot"
import { PlanStore, REPORT_RETRY_MAX, defaultPlanStore, type WriteOutcome } from "./store"
import { assertInside, assertOutputArtifact, resolveInside } from "./path-guard"
import { ChildWorkspace, type WorkspaceHandle, type WorkspaceReservation } from "./child-workspace"
import { markPlanSessionActive } from "./recovery"
import { runtimeMetricPayload, type RuntimeMetricInput } from "./runtime-event"
import { applyWorkspaceMerge, planWorkspaceMerge, workspaceFingerprint, type WorkspaceMergeTransactionResult } from "./workspace-merge"

export type ExecutionMode = "single" | "multi"

export type PlanExecutionContext = {
  workspaceRoot: string
  sessionId: string
  mode: ExecutionMode
  /** Runtime-injected only for Report calls made by a child session. */
  runId?: string
}

export type ChildStartInput = {
  parentSessionId: string
  taskId: string
  childSessionId: string
  brief: DispatchBrief
  role: LaunchSnapshot
  workspace?: DispatchRecord["workspace"]
}

export type ChildController = {
  create(input: ChildStartInput): Promise<string>
  start(input: ChildStartInput): Promise<void>
  terminate(sessionId: string): Promise<void>
}

export type CandidateBoardController = {
  postCandidateDeclaration(input: {
    sessionID: string
    approach: string
    assumptions: string[]
    risks: string[]
    differentiator: string
  }): Promise<unknown>
  candidateDeclarations(input: {
    rootSessionID: string
    stepID: string
  }): Promise<Array<{ id: string; authorTaskID?: string }>>
  candidatePeerReplyCoverage(input: {
    rootSessionID: string
    stepID: string
    taskID: string
  }): Promise<{ missingTaskIDs: string[]; complete: boolean }>
  candidateParticipants(input: {
    rootSessionID: string
    stepID: string
  }): Promise<Array<{ taskID: string; sessionID: string }>>
}

export type DispatchBrief = {
  run_id: string
  task_title: string
  goal: string
  done_criteria: string
  task_instructions?: string
  /** Absolute working directory shared with the parent agent; every relative path in the brief resolves against it. */
  workspace_root: string
  /** Absolute path resolved against workspace_root at dispatch time. */
  output_path: string
  report_format: string
  mode?: PlanTaskMode
  step_context: {
    plan_goal: string
    step_id: string
    step_title: string
    step_goal: string
    step_done_criteria: string
  }
  step_directory?: Array<{
    task_id: string
    title: string
    status: TaskStatus
    has_agent: boolean
    is_self: boolean
  }>
  blackboard_summary?: Array<{ id: string; kind: string; summary: string; task_ids: string[] }>
  previous_feedback?: { review_feedback: string; issues: string[] }
}

const childRunRegistry = new Map<string, string>()
const childPlanRoots = new Map<string, string>()
const sharedReportAttempts = new Map<string, number>()
const sharedActivities = new Map<string, Map<string, ActivityState>>()
const sharedActivityEvents = new Map<string, number>()

export function registerChildRun(childSessionId: string, runId: string, planRoot?: string) {
  childRunRegistry.set(childSessionId, runId)
  if (planRoot) childPlanRoots.set(runId, path.resolve(planRoot))
}

export function runIdForChildSession(childSessionId: string) {
  return childRunRegistry.get(childSessionId)
}

export function planRootForRunId(runId: string) {
  return childPlanRoots.get(runId)
}

/**
 * User-driven intents for a plan child run. The HTTP interrupt/terminate
 * endpoints mark an intent before cancelling the child runner; the dispatch
 * watcher in tools.ts then skips its automatic settle so the endpoint stays
 * the single source of the Inbox notification. `seq` is monotonic so a stale
 * watcher can tell a newer intent owns the run.
 */
export type ChildRunIntent = { kind: "steer" | "terminate"; seq: number; at: number }
const childRunIntents = new Map<string, ChildRunIntent>()
let childRunIntentSeq = 0

export function markChildRunIntent(childSessionId: string, kind: ChildRunIntent["kind"]) {
  const intent: ChildRunIntent = { kind, seq: ++childRunIntentSeq, at: Date.now() }
  childRunIntents.set(childSessionId, intent)
  return intent
}

export function takeChildRunIntent(childSessionId: string) {
  const intent = childRunIntents.get(childSessionId)
  if (intent) childRunIntents.delete(childSessionId)
  return intent
}

export function peekChildRunIntent(childSessionId: string) {
  return childRunIntents.get(childSessionId)
}

export function clearChildRunIntent(childSessionId: string, seq?: number) {
  const current = childRunIntents.get(childSessionId)
  if (!current) return
  if (seq !== undefined && current.seq !== seq) return
  childRunIntents.delete(childSessionId)
}

type ProtocolOptions = {
  store?: PlanStore
  events?: PlanEventHub
  wakeups?: WakeupQueue
  inbox?: PlanInbox
  children?: ChildController
  now?: () => number
  eventSink?: (event: import("./events").PlanEvent) => void
  beforeReport?: (ctx: PlanExecutionContext) => Promise<void>
  beforeStepAdvance?: (ctx: PlanExecutionContext) => Promise<void>
  profiles?: () => Promise<readonly SubagentProfile[]>
  candidateBoard?: CandidateBoardController
  childWorkspace?: ChildWorkspace
}

type WriteResult<T extends object> = { result: T; plan: PlanFile }

function asString(value: unknown) {
  return typeof value === "string" ? value.trim() : ""
}

function nowIso(now: () => number) {
  return new Date(now()).toISOString()
}

function dispatchWorkspaceMetadata(workspace: WorkspaceReservation | WorkspaceHandle): NonNullable<DispatchRecord["workspace"]> {
  return {
    mode: workspace.mode,
    root: workspace.root,
    directory: workspace.directory,
    created_at: workspace.created_at,
    cleanup: workspace.cleanup,
    baseline_directory: workspace.baseline_directory ?? null,
    baseline_manifest_hash: workspace.baseline_manifest_hash ?? null,
    source_revision: workspace.source_revision ?? null,
  }
}

function assertMain(ctx: PlanExecutionContext) {
  if (ctx.runId) {
    throw new PlanProtocolError({
      code: ERROR_CODES.FORBIDDEN_CHILD_SESSION,
      message: "子 session 不允许直接操作父 plan",
      hint: "子 session 只能调用 Report；请把结果写入 output_path 后汇报",
    })
  }
}

function assertMode(ctx: PlanExecutionContext, expected: ExecutionMode, tool: string) {
  if (ctx.mode === expected) return
  throw new PlanProtocolError({
    code: ERROR_CODES.DISPATCH_UNAVAILABLE,
    message: `${tool} 在当前智能体模式不可用`,
    hint:
      expected === "multi"
        ? "当前为单智能体模式，请自行执行该任务"
        : "当前为多智能体模式，请使用 review_task 由汇报驱动",
  })
}

function inputError(message: string, hint = "检查输入后重试"): never {
  throw new PlanProtocolError({ code: ERROR_CODES.SCHEMA_VALIDATION, message, hint })
}

function requiredText(value: unknown, field: string) {
  const text = asString(value)
  if (!text) inputError(`${field} 必须是非空字符串`)
  return text
}

/**
 * Resolve a user-supplied path against the workspace root and require the
 * result to stay inside the workspace. Relative paths never fall back to
 * process.cwd(): the workspace root is the only anchor, so a dispatched
 * child agent and its parent always resolve the same absolute location.
 */
function resolveWorkspacePath(workspaceRoot: string, value: string, field: string) {
  return resolveInside(workspaceRoot, value, field)
}

export type DispatchInput = { taskIds: string[]; role: string }

export type MergeApplyInput = {
  task_id: string
  paths?: string[]
  resolutions?: MergeResolution[]
}

function validateDispatchInput(input: unknown): asserts input is DispatchInput {
  if (!input || typeof input !== "object" || Array.isArray(input))
    inputError("Dispatch_dispatch input must be an object")
  const value = input as Record<string, unknown>
  assertOnly(value, ["taskIds", "role"], "dispatch")
  if (
    !Array.isArray(value.taskIds) ||
    value.taskIds.length < 1 ||
    value.taskIds.length > 20 ||
    !value.taskIds.every((id) => typeof id === "string" && /^s[1-9]\d*_t[1-9]\d*$/.test(id))
  )
    inputError("taskIds 必须是 1-20 个合法 taskId")
  if (new Set(value.taskIds as string[]).size !== (value.taskIds as string[]).length) inputError("taskIds 不允许重复")
  requiredText(value.role, "role")
}

function validateMergeApplyInput(input: unknown): asserts input is MergeApplyInput {
  if (!input || typeof input !== "object" || Array.isArray(input)) inputError("Merge.apply input must be an object")
  const value = input as Record<string, unknown>
  assertOnly(value, ["task_id", "paths", "resolutions"], "merge")
  if (typeof value.task_id !== "string" || !/^s[1-9]\d*_t[1-9]\d*$/.test(value.task_id))
    inputError("task_id must be a valid Task id")
  if (value.paths !== undefined) {
    if (!Array.isArray(value.paths) || value.paths.length > 200 || !value.paths.every((item) => typeof item === "string"))
      inputError("paths must contain at most 200 strings")
  }
  if (value.resolutions !== undefined) {
    if (
      !Array.isArray(value.resolutions) ||
      value.resolutions.length > 200 ||
      !value.resolutions.every(
        (item) =>
          !!item &&
          typeof item === "object" &&
          !Array.isArray(item) &&
          Object.keys(item).every((key) => key === "path" || key === "use") &&
          typeof (item as Record<string, unknown>).path === "string" &&
          ((item as Record<string, unknown>).use === "main" || (item as Record<string, unknown>).use === "child"),
      )
    )
      inputError("resolutions must contain path and use=main|child")
  }
}

function assertOnly(value: Record<string, unknown>, allowed: readonly string[], prefix: string) {
  const allowedSet = new Set(allowed)
  const extra = Object.keys(value).find((key) => !allowedSet.has(key))
  if (extra) inputError(`${prefix}.${extra} 不允许出现`, "删除未定义字段后重试")
}

function validateCreateInput(input: unknown): asserts input is CreatePlanInput {
  if (!input || typeof input !== "object" || Array.isArray(input)) inputError("Plan_create 入参必须是对象")
  const value = input as Record<string, unknown>
  assertOnly(value, ["title", "goal", "steps"], "create")
  requiredText(value.title, "title")
  requiredText(value.goal, "goal")
  if (!Array.isArray(value.steps) || value.steps.length < 2) inputError("steps 至少需要包含 2 个阶段")
  for (const [index, rawStep] of (value.steps as unknown[]).entries()) {
    if (!rawStep || typeof rawStep !== "object" || Array.isArray(rawStep)) inputError(`steps[${index}] 必须是对象`)
    const step = rawStep as Record<string, unknown>
    assertOnly(step, ["title", "goal", "done_criteria", "tasks"], `steps[${index}]`)
    requiredText(step.title, `steps[${index}].title`)
    requiredText(step.goal, `steps[${index}].goal`)
    requiredText(step.done_criteria, `steps[${index}].done_criteria`)
    if (step.tasks !== undefined && !Array.isArray(step.tasks)) inputError(`steps[${index}].tasks 必须是数组`)
    if (index > 0 && Array.isArray(step.tasks) && step.tasks.length > 0) {
      inputError(
        `steps[${index}].tasks 不允许携带任务明细`,
        "只有 steps[0] 可以携带 tasks；后续阶段用 Plan_update(add_task) 展开",
      )
    }
    for (const [taskIndex, rawTask] of (Array.isArray(step.tasks) ? step.tasks : []).entries()) {
      if (!rawTask || typeof rawTask !== "object" || Array.isArray(rawTask))
        inputError(`steps[${index}].tasks[${taskIndex}] 必须是对象`)
      const task = rawTask as Record<string, unknown>
      assertOnly(
        task,
        ["title", "goal", "done_criteria", "instructions", "output_path", "mode"],
        `steps[${index}].tasks[${taskIndex}]`,
      )
      requiredText(task.title, `steps[${index}].tasks[${taskIndex}].title`)
      requiredText(task.goal, `steps[${index}].tasks[${taskIndex}].goal`)
      requiredText(task.done_criteria, `steps[${index}].tasks[${taskIndex}].done_criteria`)
      if (task.instructions !== undefined && !asString(task.instructions))
        inputError(`steps[${index}].tasks[${taskIndex}].instructions must be non-empty`)
      if (task.output_path !== undefined && !asString(task.output_path))
        inputError(`steps[${index}].tasks[${taskIndex}].output_path must be non-empty`)
      if (task.mode !== undefined && task.mode !== "standard" && task.mode !== "candidate")
        inputError(`steps[${index}].tasks[${taskIndex}].mode must be standard or candidate`)
      if (task.mode === "candidate" && task.output_path !== undefined) {
        inputError(`steps[${index}].tasks[${taskIndex}] candidate tasks cannot provide output_path`)
      }
      const modes = (Array.isArray(step.tasks) ? step.tasks : []).map(
        (task) => (task as Record<string, unknown>).mode ?? "standard",
      )
      if (
        modes.includes("candidate") &&
        (modes.length < 2 || modes.length > 3 || modes.some((mode) => mode !== "candidate"))
      )
        inputError(`steps[${index}].tasks candidate steps require 2-3 candidate tasks and no standard tasks`)
    }
  }
}

function validateUpdateInput(input: unknown): asserts input is PlanUpdateInput {
  if (!input || typeof input !== "object" || Array.isArray(input)) inputError("Plan_update 入参必须是对象")
  const value = input as Record<string, unknown>
  assertOnly(value, ["revision", "ops"], "update")
  if (!Number.isInteger(value.revision) || Number(value.revision) < 1) inputError("revision 必须是正整数")
  if (!Array.isArray(value.ops) || value.ops.length < 1 || value.ops.length > 50) inputError("ops 必须包含 1-50 个操作")
  for (const [index, rawOp] of (value.ops as unknown[]).entries()) {
    if (!rawOp || typeof rawOp !== "object" || Array.isArray(rawOp)) inputError(`ops[${index}] 必须是对象`)
    const op = rawOp as Record<string, unknown>
    if (op.op === "review_task" && op.decision === "reject" && !asString(op.feedback))
      inputError(`ops[${index}] reject 必须提供 feedback`, "补充具体的验收缺口后重试")
    if (op.op === "reopen_task" && !asString(op.reason))
      inputError(`ops[${index}] reopen_task 必须提供 reason`, "说明为什么需要重新执行该终态任务")
  }
}

function planTaskIds(plan: PlanFile) {
  return plan.steps.flatMap((step) => step.tasks.map((task) => task.id))
}

function taskCounts(plan: PlanFile) {
  const counts: Record<TaskStatus, number> = {
    pending: 0,
    dispatched: 0,
    running: 0,
    reported: 0,
    approved: 0,
    rejected: 0,
    dismissed: 0,
  }
  for (const task of plan.steps.flatMap((step) => step.tasks)) counts[task.status]++
  return counts
}

function nextActionHint(plan: PlanFile, inboxPending: number) {
  if (inboxPending > 0) return `有 ${inboxPending} 个异常待处理：先处理 Inbox`
  const current = plan.current_step ? plan.steps.find((step) => step.id === plan.current_step) : undefined
  if (!current) return "方案已完成，可向用户交付总结"
  if (current.tasks.length === 0)
    return `${current.id} 当前没有任务，请用 Plan_update(add_task) 展开明细：默认展开 3-10 个可并行 Task（上限 20 个），能拆就拆、优先多派子 Agent`
  const candidates = current.tasks.filter((task) => task.mode === "candidate")
  if (candidates.length > 0) {
    const candidateIDs = candidates.map((task) => task.id).join("、")
    const pendingCandidates = candidates.filter((task) => task.status === "pending" || task.status === "rejected")
    if (pendingCandidates.length > 0)
      return `${current.id} 是 candidate Step；请一次调用 Dispatch_dispatch，taskIds 必须包含全部候选：${candidateIDs}`
    const phase = current.candidate_discussion?.phase
    if (phase === "declaring") return `${current.id} 候选正在盲声明，等待所有 Candidate_declare 完成后继续`
    if (phase === "cross_review")
      return `${current.id} 候选正在交叉评审，等待所有 Candidate_ready 后调用 Candidate_begin`
    if (phase === "awaiting_main") return `${current.id} 所有候选已 ready，请调用 Candidate_begin 开始独立执行`
    if (phase === "running") {
      const reportedCandidates = candidates.filter((task) => task.status === "reported")
      if (reportedCandidates.length > 0)
        return `${current.id} 已收到候选汇报：${reportedCandidates.map((task) => task.id).join("、")}；读取提案并生成综合产物后用 Plan_update(select_candidate)`
      return `${current.id} 候选正在独立执行，等待 Candidate_submit 汇报`
    }
  }
  const reported = plan.steps.flatMap((step) => step.tasks).filter((task) => task.status === "reported")
  if (reported.length) return `有 ${reported.length} 个任务待审核：${reported.map((task) => task.id).join("、")}`
  const pending = current.tasks.filter((task) => task.status === "pending" || task.status === "rejected")
  if (pending.length)
    return `${current.id} 有 ${pending.length} 个 pending/rejected 任务，可开始派发或执行；多智能体模式请一次 Dispatch_dispatch 放入全部 ready 任务，不要分批`
  if (plan.status === "done") return "方案已完成，可向用户交付总结"
  return `${current.id} 已无可立即推进的任务，等待运行中任务汇报或审核`
}

function progress(plan: PlanFile, inboxPending: number) {
  const current = plan.current_step ? plan.steps.find((step) => step.id === plan.current_step) : undefined
  return {
    plan_status: plan.status,
    current_step: current ? { id: current.id, title: current.title } : null,
    task_counts: taskCounts(plan),
    pending_review: plan.steps.flatMap((step) => step.tasks).filter((task) => task.status === "reported").length,
    inbox_pending: inboxPending,
    next_action_hint: nextActionHint(plan, inboxPending),
  }
}

function nextStepId(plan: PlanFile) {
  return `s${Math.max(0, ...plan.steps.map((step) => Number(step.id.slice(1)) || 0)) + 1}`
}

function nextTaskId(step: PlanStep) {
  const stepNo = step.id.slice(1)
  return `${step.id}_t${Math.max(0, ...step.tasks.map((task) => Number(task.id.split("_t")[1]) || 0)) + 1}`
}

function findStep(plan: PlanFile, stepId: string) {
  const step = plan.steps.find((item) => item.id === stepId)
  if (!step) {
    throw new PlanProtocolError({
      code: ERROR_CODES.STEP_NOT_FOUND,
      message: `找不到阶段 ${stepId}`,
      hint: `当前合法 stepId：${plan.steps.map((item) => item.id).join("、")}`,
    })
  }
  return step
}

function findTask(plan: PlanFile, stepId: string, taskId: string) {
  const step = findStep(plan, stepId)
  const task = step.tasks.find((item) => item.id === taskId)
  if (!task) {
    throw new PlanProtocolError({
      code: ERROR_CODES.TASK_NOT_FOUND,
      message: `找不到任务 ${taskId}`,
      hint: `当前合法 taskId：${planTaskIds(plan).join("、") || "（无）"}`,
    })
  }
  return { step, task }
}

function recomputeProgress(plan: PlanFile, workspaceRoot: string) {
  let currentIndex = plan.steps.findIndex((step) => !isStepComplete(step, workspaceRoot))
  if (currentIndex < 0) currentIndex = plan.steps.length
  plan.steps.forEach((step, index) => {
    const done = isStepComplete(step, workspaceRoot)
    step.status = done ? "done" : index === currentIndex ? "active" : "pending"
  })
  plan.current_step = currentIndex < plan.steps.length ? plan.steps[currentIndex]!.id : null
  plan.status = currentIndex >= plan.steps.length ? "done" : "active"
}

function emptyMergeRecord(status: MergeRecord["status"] = "pending"): MergeRecord {
  return {
    status,
    attempt: 0,
    applied_paths: [],
    conflicts: [],
    started_at: null,
    completed_at: null,
    target_fingerprint: null,
    cleanup: "not_started",
    journal_directory: null,
  }
}

function pathWithin(root: string, candidate: string) {
  const relative = path.relative(path.resolve(root), path.resolve(candidate))
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative))
}

function mergeJournalName(runId: string) {
  return `.jyycode-merge-${crypto.createHash("sha256").update(runId).digest("hex").slice(0, 16)}`
}

function createTask(input: CreateTaskInput, id: string, workspaceRoot?: string, rootSessionID?: string): PlanTask {
  const taskMode = input.mode ?? "standard"
  if (taskMode !== "candidate" && input.output_path && workspaceRoot) {
    resolveWorkspacePath(workspaceRoot, asString(input.output_path), "task.output_path")
  }
  return {
    id,
    title: requiredText(input.title, "task.title"),
    goal: requiredText(input.goal, "task.goal"),
    done_criteria: requiredText(input.done_criteria, "task.done_criteria"),
    ...(input.instructions ? { instructions: requiredText(input.instructions, "task.instructions") } : {}),
    output_path:
      taskMode === "candidate" && workspaceRoot && rootSessionID
        ? path.join(planDirectory(workspaceRoot, rootSessionID), "candidates", id.split("_t")[0]!, id, "proposal.md")
        : input.output_path
          ? asString(input.output_path)
          : null,
    mode: taskMode,
    status: "pending",
    dispatch: null,
    report: null,
  }
}

function createStep(input: CreateStepInput, id: string, tasks: PlanTask[] = []): PlanStep {
  const step: PlanStep = {
    id,
    title: requiredText(input.title, "step.title"),
    goal: requiredText(input.goal, "step.goal"),
    done_criteria: requiredText(input.done_criteria, "step.done_criteria"),
    status: "pending",
    tasks,
  }
  if (tasks.some((task) => task.mode === "candidate"))
    step.candidate_discussion = { phase: "declaring", ready_task_ids: [] }
  return step
}

/**
 * Candidate groups are atomic planning decisions. A later active Step may
 * initialize one by adding all candidates in the same Plan_update, but a
 * persisted candidate Step can never be extended or mixed with standard work.
 */
function finalizeCandidateGroups(plan: PlanFile) {
  for (const step of plan.steps) {
    const candidates = step.tasks.filter((task) => task.mode === "candidate")
    if (!candidates.length) continue
    if (step.tasks.some((task) => task.mode !== "candidate") || candidates.length < 2 || candidates.length > 3) {
      inputError(
        `${step.id} candidate group must contain exactly 2-3 candidate Tasks and no standard Tasks`,
        "在同一次 Plan_update 中一次性添加 2-3 个 candidate Task；不要单独添加或混入 standard Task",
      )
    }
    if (!step.candidate_discussion) step.candidate_discussion = { phase: "declaring", ready_task_ids: [] }
  }
}

function applyEditPlan(plan: PlanFile, fields: { title?: string; goal?: string }) {
  if (plan.status === "done") {
    throw new PlanProtocolError({
      code: ERROR_CODES.PLAN_FINALIZED,
      message: "方案已完结，只读",
      hint: "方案已完结，只读",
    })
  }
  if (fields.title !== undefined) plan.title = requiredText(fields.title, "title")
  if (fields.goal !== undefined) plan.goal = requiredText(fields.goal, "goal")
}

function applyOp(
  plan: PlanFile,
  op: PlanUpdateOp,
  mode: ExecutionMode,
  assigned: { steps: string[]; tasks: string[] },
  reviewed: Array<{ taskId: string; result: "approved" | "rejected" }>,
  workspaceRoot?: string,
  rootSessionID?: string,
) {
  if (!op || typeof op !== "object" || !("op" in op)) inputError("ops 含有无效操作")
  switch (op.op) {
    case "edit_plan":
      applyEditPlan(plan, op.fields)
      return
    case "add_step": {
      const after = op.after
      if (after !== undefined) {
        const afterIndex = plan.steps.findIndex((step) => step.id === after)
        if (afterIndex < 0) findStep(plan, after)
        if (plan.steps.slice(afterIndex + 1).some((step) => step.status === "done")) {
          throw new PlanProtocolError({
            code: ERROR_CODES.INVALID_STATE,
            message: "不允许在已完成区域插入",
            hint: "不允许在已完成区域插入",
          })
        }
      }
      const id = nextStepId(plan)
      const newStep = createStep(op.step, id)
      const index = after === undefined ? plan.steps.length : plan.steps.findIndex((step) => step.id === after) + 1
      plan.steps.splice(index, 0, newStep)
      assigned.steps.push(id)
      return
    }
    case "edit_step": {
      const step = findStep(plan, op.stepId)
      if (step.status === "done") {
        throw new PlanProtocolError({
          code: ERROR_CODES.INVALID_STATE,
          message: "已 done，不可修改",
          hint: "已 done，不可修改；如需追加工作请 add_step",
        })
      }
      if (op.fields.title !== undefined) step.title = requiredText(op.fields.title, "title")
      if (op.fields.goal !== undefined) step.goal = requiredText(op.fields.goal, "goal")
      if (op.fields.done_criteria !== undefined)
        step.done_criteria = requiredText(op.fields.done_criteria, "done_criteria")
      return
    }
    case "remove_step": {
      const step = findStep(plan, op.stepId)
      if (step.status !== "pending" || op.stepId === plan.current_step) {
        throw new PlanProtocolError({
          code: ERROR_CODES.INVALID_STATE,
          message: "进行中或已完成阶段不可删除",
          hint: "进行中或已完成阶段不可删除",
        })
      }
      plan.steps = plan.steps.filter((item) => item.id !== op.stepId)
      return
    }
    case "add_task": {
      const step = findStep(plan, op.stepId)
      if (step.id !== plan.current_step || step.status !== "active") {
        throw new PlanProtocolError({
          code: ERROR_CODES.INVALID_STATE,
          message: `只有当前 active 阶段可以展开任务，${step.id} 当前为 ${step.status}`,
          hint: `请只对 current_step=${plan.current_step ?? "null"} 使用 add_task；后续阶段保持 Task 骨架为空`,
        })
      }
      if (step.candidate_discussion)
        inputError(
          "不能向已有 candidate Step 追加 Task",
          "候选组必须在 Plan_create 或该 Step 首次激活时的一次 Plan_update 中完整初始化；不要扩展已有 candidate Step",
        )
      if (op.task.mode === "candidate" && step.tasks.some((task) => task.mode !== "candidate"))
        inputError(
          "candidate Task 不能与 standard Task 混合",
          "在同一次 Plan_update 中只添加 2-3 个 candidate Task，或只添加 standard Task",
        )
      if (op.task.mode === "candidate" && step.tasks.length >= 3)
        inputError("candidate Step 最多包含 3 个 Task", "candidate group 只能包含 2-3 个候选")
      if (op.task.mode !== "candidate" && step.tasks.some((task) => task.mode === "candidate"))
        inputError(
          "standard Task 不能加入 candidate Step",
          "候选组必须只包含 candidate Task；如需普通并行，请重新规划为 standard Task 组",
        )
      const id = nextTaskId(step)
      step.tasks.push(createTask(op.task, id, workspaceRoot, rootSessionID))
      assigned.tasks.push(id)
      return
    }
    case "edit_task": {
      const { task } = findTask(plan, op.stepId, op.taskId)
      if (!(task.status === "pending" || task.status === "rejected")) {
        throw new PlanProtocolError({
          code: ERROR_CODES.INVALID_STATE,
          message: `任务 ${task.id} 当前为 ${task.status}，不允许 edit_task`,
          hint: "执行中任务先 Dispatch_cancel 再 edit",
        })
      }
      if (op.fields.title !== undefined) task.title = requiredText(op.fields.title, "title")
      if (op.fields.goal !== undefined) task.goal = requiredText(op.fields.goal, "goal")
      if (op.fields.done_criteria !== undefined)
        task.done_criteria = requiredText(op.fields.done_criteria, "done_criteria")
      if (op.fields.instructions !== undefined) task.instructions = requiredText(op.fields.instructions, "instructions")
      if (op.fields.output_path !== undefined) {
        const value = requiredText(op.fields.output_path, "output_path")
        if (workspaceRoot) resolveWorkspacePath(workspaceRoot, value, `任务 ${op.taskId} 的 output_path`)
        task.output_path = value
      }
      return
    }
    case "remove_task": {
      const { step, task } = findTask(plan, op.stepId, op.taskId)
      if (task.status !== "pending") {
        throw new PlanProtocolError({
          code: ERROR_CODES.INVALID_STATE,
          message: `任务 ${task.id} 当前为 ${task.status}，不允许删除`,
          hint: "仅允许删除 pending 任务",
        })
      }
      step.tasks = step.tasks.filter((item) => item.id !== task.id)
      return
    }
    case "reopen_task": {
      const { task } = findTask(plan, op.stepId, op.taskId)
      if (!(task.status === "reported" || task.status === "approved" || task.status === "rejected" || task.status === "dismissed"))
        throw new PlanProtocolError({
          code: ERROR_CODES.INVALID_STATE,
          message: `任务 ${task.id} 当前为 ${task.status}，不可 reopen_task`,
          hint: "只有已汇报或已审核的终态任务可以显式 reopen_task",
        })
      task.status = "pending"
      task.dispatch = null
      task.report = null
      task.reopen_reason = requiredText(op.reason, "reason")
      return
    }
    case "set_task_status": {
      if (mode !== "single") {
        throw new PlanProtocolError({
          code: ERROR_CODES.DISPATCH_UNAVAILABLE,
          message: "多智能体模式不可直接设置任务状态",
          hint: "请使用 review_task，由汇报驱动任务状态",
        })
      }
      const { task } = findTask(plan, op.stepId, op.taskId)
      const allowed: Record<TaskStatus, TaskStatus[]> = {
        pending: ["running"],
        dispatched: [],
        running: ["reported"],
        reported: ["approved", "rejected"],
        approved: [],
        rejected: ["running"],
        dismissed: [],
      }
      const to = op.to as TaskStatus
      if (!allowed[task.status].includes(to)) {
        throw new PlanProtocolError({
          code: ERROR_CODES.INVALID_STATE,
          message: `任务 ${task.id} 不允许从 ${task.status} 转为 ${to}`,
          hint: `当前允许的转换：${allowed[task.status].join(", ") || "无"}`,
        })
      }
      task.status = to
      return
    }
    case "review_task": {
      if (mode !== "multi") {
        throw new PlanProtocolError({
          code: ERROR_CODES.DISPATCH_UNAVAILABLE,
          message: "单智能体模式不可调用 review_task",
          hint: "请使用 set_task_status 推进任务",
        })
      }
      const { task } = findTask(plan, op.stepId, op.taskId)
      if (task.mode === "candidate")
        throw new PlanProtocolError({
          code: ERROR_CODES.INVALID_STATE,
          message: "candidate task must be finalized with select_candidate",
          hint: "先生成综合产物，再使用 select_candidate 原子选择候选",
        })
      if (task.status !== "reported") {
        throw new PlanProtocolError({
          code: ERROR_CODES.INVALID_STATE,
          message: "该任务不在待审核状态",
          hint: "该任务不在待审核状态",
        })
      }
      if (op.decision === "reject" && !asString(op.feedback)) inputError("reject 必须提供 feedback")
      task.status = op.decision === "approve" ? "approved" : "rejected"
      if (task.report)
        task.report.review_feedback = op.decision === "reject" ? asString(op.feedback) : task.report.review_feedback
      reviewed.push({ taskId: task.id, result: op.decision === "approve" ? "approved" : "rejected" })
      return
    }
    case "select_candidate": {
      const step = findStep(plan, op.stepId)
      const candidates = step.tasks.filter((task) => task.mode === "candidate")
      if (candidates.length < 2 || candidates.length > 3 || candidates.length !== step.tasks.length)
        inputError("select_candidate 只能用于包含 2-3 个 candidate task 的 Step")
      if (step.candidate_selection) inputError("candidate Step 已经完成选择")
      const selected = candidates.find((task) => task.id === op.selectedTaskId)
      if (!selected) inputError("selectedTaskId 必须属于当前 candidate Step")
      const contributing = op.contributingTaskIds ?? []
      if (
        new Set(contributing).size !== contributing.length ||
        contributing.some((id) => !candidates.some((task) => task.id === id))
      )
        inputError("contributingTaskIds 必须属于当前 candidate Step 且不能重复")
      if (!candidates.every((task) => (task.status === "reported" || task.status === "rejected") && task.report))
        throw new PlanProtocolError({
          code: ERROR_CODES.INVALID_STATE,
          message: "所有 candidate task 必须先提交 report",
          hint: "等待所有候选完成 Candidate_submit 后再选择",
        })
      if (selected.status !== "reported" || selected.report?.status !== "done")
        throw new PlanProtocolError({
          code: ERROR_CODES.INVALID_STATE,
          message: "selected candidate 必须是 done 的 reported task",
          hint: "只能选择已成功提交方案的候选",
        })
      const synthesis = requiredText(op.synthesisArtifact, "synthesisArtifact")
      if (!workspaceRoot)
        throw new PlanProtocolError({
          code: ERROR_CODES.INVALID_STATE,
          message: "select_candidate 缺少 workspaceRoot，无法定位综合产物",
          hint: "通过带 workspaceRoot 的执行上下文重试",
        })
      const absoluteSynthesis = resolveWorkspacePath(workspaceRoot, synthesis, "synthesisArtifact")
      if (!fs.existsSync(absoluteSynthesis)) inputError("synthesisArtifact 必须是 workspace 内已存在的文件")
      selected.status = "approved"
      for (const task of candidates) if (task.id !== selected.id) task.status = "dismissed"
      step.candidate_selection = {
        selected_task_id: selected.id,
        contributing_task_ids: contributing,
        synthesis_artifact: synthesis,
        rationale: requiredText(op.rationale, "rationale"),
        selected_at: new Date().toISOString(),
      }
      return
    }
    default:
      inputError(`不支持的操作 ${(op as { op?: unknown }).op ?? "（缺失）"}`)
  }
}

function parseRunId(runId: string) {
  const match = /^run__(.+)__(s[1-9]\d*_t[1-9]\d*)$/.exec(runId)
  return match ? { parentSessionId: match[1]!, taskId: match[2]! } : undefined
}

function validateCandidateDeclarationInput(input: unknown) {
  if (!input || typeof input !== "object" || Array.isArray(input))
    inputError("Candidate_declare input must be an object")
  const value = input as Record<string, unknown>
  assertOnly(value, ["approach", "assumptions", "risks", "differentiator"], "candidate.declare")
  const approach = requiredText(value.approach, "approach")
  const differentiator = requiredText(value.differentiator, "differentiator")
  const list = (value: unknown, field: string) => {
    if (!Array.isArray(value) || value.length > 20) inputError(`${field} must be an array of at most 20 strings`)
    return value.map((item) => requiredText(item, `${field}[]`))
  }
  return {
    approach,
    assumptions: list(value.assumptions, "assumptions"),
    risks: list(value.risks, "risks"),
    differentiator,
  }
}

function validateCandidateSubmitInput(input: unknown) {
  if (!input || typeof input !== "object" || Array.isArray(input))
    inputError("Candidate_submit input must be an object")
  const value = input as Record<string, unknown>
  assertOnly(value, ["run_id", "status", "summary", "proposal"], "candidate.submit")
  const runId = requiredText(value.run_id, "run_id")
  const status = value.status
  if (status !== "done" && status !== "partial" && status !== "failed")
    inputError("status must be done, partial, or failed")
  return {
    runId,
    status,
    summary: requiredText(value.summary, "summary"),
    proposal: requiredText(value.proposal, "proposal"),
  }
}

export function parentSessionIdForRunId(runId: string) {
  return parseRunId(runId)?.parentSessionId
}

export class PlanProtocol {
  readonly store: PlanStore
  readonly events: PlanEventHub
  readonly wakeups: WakeupQueue
  readonly inbox: PlanInbox
  private readonly children?: ChildController
  private readonly candidateBoard?: CandidateBoardController
  private readonly childWorkspace?: ChildWorkspace
  private readonly now: () => number
  private readonly eventSink?: (event: import("./events").PlanEvent) => void
  private readonly beforeReport?: (ctx: PlanExecutionContext) => Promise<void>
  private readonly beforeStepAdvance?: (ctx: PlanExecutionContext) => Promise<void>
  private readonly profiles: () => Promise<readonly SubagentProfile[]>
  private readonly reportAttempts = sharedReportAttempts
  private readonly activities = sharedActivities
  private readonly activityEvents = sharedActivityEvents

  constructor(options: ProtocolOptions = {}) {
    this.store = options.store ?? defaultPlanStore
    this.events = options.events ?? defaultPlanEvents
    this.wakeups = options.wakeups ?? defaultWakeupQueue
    this.inbox = options.inbox ?? defaultPlanInbox
    this.children = options.children
    this.candidateBoard = options.candidateBoard
    this.childWorkspace = options.childWorkspace
    this.now = options.now ?? Date.now
    this.eventSink = options.eventSink
    this.beforeReport = options.beforeReport
    this.beforeStepAdvance = options.beforeStepAdvance
    this.profiles = options.profiles ?? (() => Promise.resolve(defaultProfiles()))
  }

  private publish(event: Parameters<PlanEventHub["publish"]>[0]) {
    const result = this.events.publish(event)
    this.eventSink?.(result)
    return result
  }

  private metric(sessionId: string, input: RuntimeMetricInput) {
    return this.publish({
      type: "runtime.metric",
      session_id: sessionId,
      payload: runtimeMetricPayload(input),
    })
  }

  private path(ctx: PlanExecutionContext, sessionId = ctx.sessionId) {
    return planFilePath((ctx.runId && planRootForRunId(ctx.runId)) ?? ctx.workspaceRoot, sessionId)
  }

  private async resolveProfile(id: string) {
    const profile = profileByID(enabledProfiles(await this.profiles()), id)
    if (!profile)
      throw new PlanProtocolError({
        code: ERROR_CODES.DISPATCH_UNAVAILABLE,
        message: `subagent role unavailable: ${id}`,
        hint: "Choose an enabled role from the current dispatch roster.",
      })
    return profile
  }

  private candidateBoardOrThrow() {
    if (!this.candidateBoard)
      throw new PlanProtocolError({
        code: ERROR_CODES.INVALID_STATE,
        message: "candidate Blackboard service is unavailable",
        hint: "通过候选专用运行时调用 Candidate 工具",
      })
    return this.candidateBoard
  }

  private candidateChildState(ctx: PlanExecutionContext) {
    if (!ctx.runId)
      throw new PlanProtocolError({
        code: ERROR_CODES.FORBIDDEN_CHILD_SESSION,
        message: "Candidate 工具只能由候选 child session 调用",
        hint: "root session 使用 Candidate_begin 或 Plan_update(select_candidate)",
      })
    const parsed = parseRunId(ctx.runId)
    if (!parsed)
      throw new PlanProtocolError({
        code: ERROR_CODES.RUN_NOT_FOUND,
        message: "run_id 无法解析",
        hint: "使用当前候选 dispatch 提供的 run_id",
      })
    const plan = this.store.read(this.path(ctx, parsed.parentSessionId))
    if (!plan)
      throw new PlanProtocolError({
        code: ERROR_CODES.RUN_NOT_FOUND,
        message: "找不到父 plan",
        hint: "候选 run 已失效",
      })
    const step = plan.steps.find((item) => item.tasks.some((task) => task.id === parsed.taskId))
    const task = step?.tasks.find((item) => item.id === parsed.taskId)
    if (
      !step ||
      !task ||
      task.mode !== "candidate" ||
      task.dispatch?.run_id !== ctx.runId ||
      task.dispatch.child_session_id !== ctx.sessionId
    )
      throw new PlanProtocolError({
        code: ERROR_CODES.FORBIDDEN_CHILD_SESSION,
        message: "当前 child session 不属于该 candidate run",
        hint: "停止使用过期或伪造的 run_id",
      })
    return { parsed, plan, step, task, parentContext: { ...ctx, sessionId: parsed.parentSessionId } }
  }

  private async write<T extends object>(
    ctx: PlanExecutionContext,
    apply: (latest: PlanFile | null) => WriteOutcome<T>,
  ): Promise<WriteResult<T>> {
    markPlanSessionActive(ctx.workspaceRoot, ctx.sessionId)
    const planPath = this.path(ctx)
    const result = await this.store.enqueueWrite(planPath, {
      priority: ctx.runId ? "normal" : "high",
      holder: ctx.runId ?? ctx.sessionId,
      retryableOnTimeout: Boolean(ctx.runId),
      apply,
    })
    const plan = this.store.read(planPath)
    if (!plan) throw new Error("plan 写入后无法读取")
    const snapshot = projectPlanSnapshot(plan, {
      inboxPending: this.inbox.pendingCount(ctx.sessionId),
      activities: this.activities.get(ctx.sessionId),
    })
    this.publish({ type: "plan.updated", session_id: ctx.sessionId, revision: plan.revision, payload: snapshot })
    return { result, plan }
  }

  private async updateDispatchLifecycle(
    ctx: PlanExecutionContext,
    taskId: string,
    input: { lifecycle?: DispatchRecord["lifecycle"]; status?: TaskStatus; child_session_id?: string; workspace?: DispatchRecord["workspace"] },
  ) {
    await this.write(ctx, (latest) => {
      if (!latest)
        throw new PlanProtocolError({
          code: ERROR_CODES.RUN_NOT_FOUND,
          message: "找不到父 plan",
          hint: "重新读取 Plan 后恢复派发",
        })
      const next = clonePlan(latest)
      const task = next.steps.flatMap((step) => step.tasks).find((item) => item.id === taskId)
      if (!task?.dispatch)
        throw new PlanProtocolError({
          code: ERROR_CODES.RUN_NOT_FOUND,
          message: `任务 ${taskId} 缺少 dispatch 记录`,
          hint: "只能恢复包含 dispatch metadata 的任务",
        })
      if (input.lifecycle !== undefined) task.dispatch.lifecycle = input.lifecycle
      if (input.child_session_id !== undefined) task.dispatch.child_session_id = input.child_session_id
      if (input.workspace !== undefined) task.dispatch.workspace = input.workspace
      if (input.status !== undefined) task.status = input.status
      if ((task.mode ?? "standard") === "standard" && !task.merge) task.merge = emptyMergeRecord("pending")
      next.revision++
      next.updated_at = nowIso(this.now)
      return {
        mutate(target) {
          Object.assign(target, next)
        },
        result: { updated: true },
      }
    })
  }

  private recordedWorkspace(ctx: PlanExecutionContext, task: PlanTask): WorkspaceHandle | undefined {
    const workspace = task.dispatch?.workspace
    if (!workspace || !this.childWorkspace) return undefined
    const reservation = this.childWorkspace.reserve(ctx.sessionId, task.id)
    return this.childWorkspace.load({
      ...reservation,
      ...workspace,
      rootSessionId: ctx.sessionId,
      taskId: task.id,
      name: reservation.name,
    })
  }

  private async cleanupTaskWorkspace(ctx: PlanExecutionContext, taskId: string) {
    const plan = this.store.read(this.path(ctx))
    const task = plan?.steps.flatMap((step) => step.tasks).find((item) => item.id === taskId)
    const workspace = task?.dispatch?.workspace
    if (!task || !workspace || workspace.mode === "shared_compat") return [] as string[]
    const errors: string[] = []
    try {
      if (task.dispatch?.child_session_id && this.children)
        await this.children.terminate(task.dispatch.child_session_id)
    } catch (error) {
      errors.push(`child cleanup: ${error instanceof Error ? error.message : String(error)}`)
    }
    try {
      if (!this.childWorkspace) throw new Error("child workspace manager unavailable")
      const loaded = this.recordedWorkspace(ctx, task)
      if (!loaded) throw new Error("recorded child workspace is missing")
      await this.childWorkspace.remove(loaded.directory)
    } catch (error) {
      errors.push(`workspace cleanup: ${error instanceof Error ? error.message : String(error)}`)
    }
    if (errors.length) {
      try {
        await this.write(ctx, (latest) => {
          if (!latest) throw new Error("plan missing while recording cleanup failure")
          const next = clonePlan(latest)
          const target = next.steps.flatMap((step) => step.tasks).find((item) => item.id === taskId)
          if (target?.merge) {
            target.merge.cleanup = "failed"
            target.merge.cleanup_error = errors.join("; ")
          }
          next.revision++
          next.updated_at = nowIso(this.now)
          return {
            mutate(planTarget) {
              Object.assign(planTarget, next)
            },
            result: { updated: true },
          }
        })
      } catch (error) {
        errors.push(`record cleanup failure: ${error instanceof Error ? error.message : String(error)}`)
      }
      this.inbox.add({
        session_id: ctx.sessionId,
        task_id: taskId,
        run_id: task.dispatch?.run_id,
        kind: "runtime_error",
        message: `Task ${taskId} cleanup failed: ${errors.join("; ")}`,
        suggested_actions: ["read Inbox", "inspect the recorded workspace before redispatching"],
      })
    }
    return errors
  }

  private async failDispatch(
    ctx: PlanExecutionContext,
    input: {
      taskId: string
      childSessionId?: string
      workspaceDirectory?: string | null
      error: unknown
    },
  ) {
    const message = input.error instanceof Error ? input.error.message : String(input.error)
    try {
      await this.updateDispatchLifecycle(ctx, input.taskId, { lifecycle: "settled", status: "rejected" })
    } catch {
      // Keep the original failure visible in Inbox even if the recovery write races another writer.
    }
    const cleanupErrors: string[] = []
    if (input.childSessionId && this.children) {
      try {
        await this.children.terminate(input.childSessionId)
      } catch (error) {
        cleanupErrors.push(`child cleanup: ${error instanceof Error ? error.message : String(error)}`)
      }
    }
    if (input.workspaceDirectory && this.childWorkspace) {
      try {
        await this.childWorkspace.remove(input.workspaceDirectory)
      } catch (error) {
        cleanupErrors.push(`workspace cleanup: ${error instanceof Error ? error.message : String(error)}`)
      }
    }
    this.metric(ctx.sessionId, {
      metric: "dispatch",
      phase: "cleanup",
      outcome: cleanupErrors.length > 0 ? "failed" : "completed",
      count: cleanupErrors.length,
    })
    this.inbox.add({
      session_id: ctx.sessionId,
      task_id: input.taskId,
      kind: "runtime_error",
      message: `Dispatch ${input.taskId} 失败：${[message, ...cleanupErrors].join("；")}`,
      suggested_actions: ["读取 Inbox 查看失败阶段", "必要时用同一任务重新 Dispatch_dispatch"],
    })
  }

  async read(
    ctx: PlanExecutionContext,
  ): Promise<ProtocolResponse<{ plan: PlanFile | null; progress?: ReturnType<typeof progress> }>> {
    try {
      assertMain(ctx)
      const plan = this.store.read(this.path(ctx))
      return plan
        ? { ok: true, plan, progress: progress(plan, this.inbox.pendingCount(ctx.sessionId)) }
        : { ok: true, plan: null }
    } catch (error) {
      return responseFromError(error)
    }
  }

  async readInbox(
    ctx: PlanExecutionContext,
    input: unknown = {},
  ): Promise<
    ProtocolResponse<{
      items: Array<
        ReturnType<PlanInbox["list"]>[number] & {
          suggested_actions: string[]
        }
      >
    }>
  > {
    try {
      assertMain(ctx)
      if (!input || typeof input !== "object" || Array.isArray(input)) inputError("Inbox 入参必须是对象")
      const value = input as Record<string, unknown>
      assertOnly(value, ["mark_handled"], "inbox")
      const markHandled = value.mark_handled
      if (
        markHandled !== undefined &&
        (!Array.isArray(markHandled) || !markHandled.every((id) => typeof id === "string"))
      )
        inputError("mark_handled 必须是字符串数组")
      for (const id of (markHandled as string[] | undefined) ?? []) this.inbox.resolve(ctx.sessionId, id)

      const items = this.inbox.pending(ctx.sessionId).map((entry) => ({
        ...entry,
        suggested_actions:
          entry.suggested_actions ??
          (entry.kind === "report_precheck_failed"
            ? [
                "确认 output_path 下的产出文件已写入后，用同一 run_id 重新提交 Report",
                "检查任务定义与 output_path，必要时用 Plan_update(edit_task) 修正后重新 dispatch",
                "主 Agent 直接执行该任务并用 Plan_update 推进状态",
              ]
            : entry.kind === "cancelled"
              ? ["重新评估任务是否仍需执行", "修正任务定义后重新 dispatch"]
              : ["查看运行时错误上下文", "必要时取消并重新 dispatch 相关任务"]),
      }))
      if (markHandled && (markHandled as unknown[]).length > 0) {
        const plan = this.store.read(this.path(ctx))
        if (plan) {
          this.publish({
            type: "plan.updated",
            session_id: ctx.sessionId,
            revision: plan.revision,
            payload: projectPlanSnapshot(plan, {
              inboxPending: this.inbox.pendingCount(ctx.sessionId),
              activities: this.activities.get(ctx.sessionId),
            }),
          })
        }
      }
      return { ok: true, items }
    } catch (error) {
      return responseFromError(error)
    }
  }

  async create(
    ctx: PlanExecutionContext,
    input: unknown,
  ): Promise<
    ProtocolResponse<{
      plan_id_assigned: { steps: string[]; tasks: Record<string, string[]> }
      revision: number
      current_step: string
      next_action_hint: string
    }>
  > {
    try {
      assertMain(ctx)
      validateCreateInput(input)
      const assigned = { steps: [] as string[], tasks: {} as Record<string, string[]> }
      const result = await this.write(ctx, (latest) => {
        if (latest) {
          throw new PlanProtocolError({
            code: ERROR_CODES.INVALID_STATE,
            message: "已有方案",
            hint: "已有方案，请用 Plan_update 修改",
          })
        }
        const value = input as CreatePlanInput
        const steps = value.steps.map((step, index) => {
          const id = `s${index + 1}`
          assigned.steps.push(id)
          const taskIds: string[] = []
          const tasks = (index === 0 ? (step.tasks ?? []) : []).map((task, taskIndex) => {
            const taskId = `${id}_t${taskIndex + 1}`
            taskIds.push(taskId)
            return createTask(task, taskId, ctx.workspaceRoot, ctx.sessionId)
          })
          assigned.tasks[id] = taskIds
          return createStep(step, id, tasks)
        })
        const timestamp = nowIso(this.now)
        const plan: PlanFile = {
          title: value.title.trim(),
          goal: value.goal.trim(),
          status: "active",
          revision: 1,
          current_step: "s1",
          steps,
          created_at: timestamp,
          updated_at: timestamp,
        }
        recomputeProgress(plan, ctx.workspaceRoot)
        return {
          mutate(target) {
            Object.assign(target, plan)
          },
          result: { revision: 1, current_step: "s1", next_action_hint: nextActionHint(plan, 0) },
        }
      })
      return { ok: true, plan_id_assigned: assigned, ...result.result }
    } catch (error) {
      return responseFromError(error)
    }
  }

  async update(
    ctx: PlanExecutionContext,
    input: unknown,
  ): Promise<
    ProtocolResponse<{
      assigned_ids?: { steps?: string[]; tasks?: string[] }
      reviewed?: Array<{ taskId: string; result: "approved" | "rejected" }>
      revision: number
      next_action_hint: string
    }>
  > {
    try {
      assertMain(ctx)
      validateUpdateInput(input)
      const value = input as PlanUpdateInput
      const latestForGate = this.store.read(this.path(ctx))
      if (this.beforeStepAdvance && latestForGate && latestForGate.revision === value.revision) {
        const projected = clonePlan(latestForGate)
        const projectedAssigned = { steps: [] as string[], tasks: [] as string[] }
        const projectedReviewed: Array<{ taskId: string; result: "approved" | "rejected" }> = []
        for (const op of value.ops)
          applyOp(projected, op, ctx.mode, projectedAssigned, projectedReviewed, ctx.workspaceRoot, ctx.sessionId)
        recomputeProgress(projected, ctx.workspaceRoot)
        // A completed plan has no current Step. Resuming it with a new Step is
        // a fresh wave, not an advance from one active Step to the next, so
        // there is no current-Step Blackboard backlog that must be read first.
        if (latestForGate.current_step !== null && projected.current_step !== latestForGate.current_step)
          await this.beforeStepAdvance(ctx)
      }
      const assigned = { steps: [] as string[], tasks: [] as string[] }
      const reviewed: Array<{ taskId: string; result: "approved" | "rejected" }> = []
      const result = await this.write(ctx, (latest) => {
        if (!latest)
          throw new PlanProtocolError({
            code: ERROR_CODES.INVALID_STATE,
            message: "当前 session 没有方案",
            hint: "先调用 Plan_create 创建方案",
          })
        if (latest.revision !== value.revision) {
          throw new PlanProtocolError({
            code: ERROR_CODES.REVISION_CONFLICT,
            message: "携带的 revision 已过期",
            hint: "以随附的最新 plan 为准重新决策，不要机械重发原 patch",
            latest_plan: latest,
            latest_revision: latest.revision,
          })
        }
        const draft = clonePlan(latest)
        try {
          for (const [index, op] of value.ops.entries()) {
            try {
              applyOp(draft, op, ctx.mode, assigned, reviewed, ctx.workspaceRoot, ctx.sessionId)
            } catch (error) {
              if (error instanceof PlanProtocolError) {
                throw new PlanProtocolError({
                  ...error.toResponse().error,
                  message: `ops[${index}] 失败：${error.message}`,
                  rolled_back: true,
                })
              }
              throw error
            }
          }
        } catch (error) {
          throw error
        }
        finalizeCandidateGroups(draft)
        recomputeProgress(draft, ctx.workspaceRoot)
        draft.revision = latest.revision + 1
        draft.updated_at = nowIso(this.now)
        const nextHint = nextActionHint(draft, this.inbox.pendingCount(ctx.sessionId))
        return {
          mutate(target) {
            Object.assign(target, draft)
          },
          result: {
            ...(assigned.steps.length || assigned.tasks.length ? { assigned_ids: assigned } : {}),
            ...(reviewed.length ? { reviewed } : {}),
            revision: draft.revision,
            next_action_hint: nextHint,
          },
        }
      })
      for (const review of result.result.reviewed ?? []) {
        if (review.result === "rejected") await this.cleanupTaskWorkspace(ctx, review.taskId)
      }
      return { ok: true, ...result.result }
    } catch (error) {
      return responseFromError(error)
    }
  }

  async dispatch(
    ctx: PlanExecutionContext,
    input: unknown,
  ): Promise<
    ProtocolResponse<{
      dispatched: Array<{ taskId: string; run_id: string; child_session_id: string; idempotent: boolean }>
      next_action_hint: string
    }>
  > {
    try {
      assertMain(ctx)
      assertMode(ctx, "multi", "Dispatch_dispatch")
      validateDispatchInput(input)
      const taskIds = input.taskIds
      const plan = this.store.read(this.path(ctx))
      if (!plan)
        throw new PlanProtocolError({
          code: ERROR_CODES.INVALID_STATE,
          message: "当前 session 没有方案",
          hint: "先调用 Plan_create",
        })
      const targets = (taskIds as string[]).map((id) => {
        const step = plan.steps.find((item) => item.tasks.some((task) => task.id === id))
        if (!step)
          throw new PlanProtocolError({
            code: ERROR_CODES.TASK_NOT_FOUND,
            message: `找不到任务 ${id}`,
            hint: `当前合法 taskId：${planTaskIds(plan).join("、")}`,
          })
        const task = step.tasks.find((item) => item.id === id)!
        if (step.id !== plan.current_step || step.status !== "active")
          inputError(
            `任务 ${id} 不属于当前 active 阶段`,
            `只允许派发 current_step=${plan.current_step ?? "null"} 中的任务`,
          )
        return { step, task }
      })
      const candidateSteps = [
        ...new Map(targets.filter(({ task }) => task.mode === "candidate").map(({ step }) => [step.id, step])).values(),
      ]
      if (candidateSteps.length > 1) inputError("一次 Dispatch_dispatch 不能跨越多个 candidate Step")
      const candidateStep = candidateSteps[0]
      if (candidateStep) {
        const candidateTaskIDs = candidateStep.tasks.map((task) => task.id)
        if (
          candidateTaskIDs.length < 2 ||
          candidateTaskIDs.length > 3 ||
          taskIds.length !== candidateTaskIDs.length ||
          candidateTaskIDs.some((id) => !taskIds.includes(id))
        )
          inputError("candidate Step 必须在一次 Dispatch_dispatch 中包含全部候选 Task")
      }
      const dispatched: Array<{ taskId: string; run_id: string; child_session_id: string; idempotent: boolean }> = []
      const prepared = new Map<
        string,
        {
          dispatch: DispatchRecord
          brief: DispatchBrief
          role: LaunchSnapshot
          reservation?: WorkspaceReservation
        }
      >()
      const needsRole = targets.some(({ task }) => task.status !== "dispatched" && task.status !== "running")
      const role = needsRole ? await this.resolveProfile(input.role) : undefined
      for (const { step, task } of targets) {
        if (task.status === "dispatched" || task.status === "running") {
          if (!task.dispatch)
            throw new PlanProtocolError({
              code: ERROR_CODES.SCHEMA_VALIDATION,
              message: `任务 ${task.id} 缺少 dispatch 记录`,
              hint: "修复方案状态后重试",
            })
          dispatched.push({
            taskId: task.id,
            run_id: task.dispatch.run_id,
            child_session_id: task.dispatch.child_session_id,
            idempotent: true,
          })
          continue
        }
        if (task.status !== "pending" && task.status !== "rejected")
          inputError(`任务 ${task.id} 当前为 ${task.status}，不可派发`, "只允许派发 pending 或 rejected 任务")
        if (!task.output_path || !task.done_criteria)
          inputError(
            `任务 ${task.id} 缺少 output_path 或 done_criteria`,
            "派发型任务必须提供 output_path 与 done_criteria",
          )
        if (!role) throw new Error("Dispatch_dispatch role resolution failed")
        // Anchor every dispatched path at the workspace root: the child session
        // shares the parent's working directory, so the brief carries only
        // absolute paths and relative paths can never drift to process.cwd().
        const outputPath = resolveWorkspacePath(ctx.workspaceRoot, task.output_path!, `任务 ${task.id} 的 output_path`)
        const runId = `run__${ctx.sessionId}__${task.id}`
        const childSessionId = `child_${ctx.sessionId}_${task.id}`
        const brief: DispatchBrief = {
          run_id: runId,
          task_title: task.title,
          goal: task.goal,
          done_criteria: task.done_criteria,
          ...(task.instructions ? { task_instructions: task.instructions } : {}),
          workspace_root: path.resolve(ctx.workspaceRoot),
          output_path: outputPath,
          mode: task.mode ?? "standard",
          step_context: {
            plan_goal: plan.goal,
            step_id: step.id,
            step_title: step.title,
            step_goal: step.goal,
            step_done_criteria: step.done_criteria,
          },
          report_format:
            "调用 Report({run_id,status,summary,artifacts?,issues?})；status=done 时 artifacts 必须列出真实存在的产出文件。",
          step_directory: (plan.steps.find((step) => step.id === plan.current_step)?.tasks ?? []).map((item) => ({
            task_id: item.id,
            title: item.title,
            status: item.status,
            has_agent: !!item.dispatch?.child_session_id,
            is_self: item.id === task.id,
          })),
          ...(task.report?.review_feedback
            ? { previous_feedback: { review_feedback: task.report.review_feedback, issues: task.report.issues } }
            : {}),
        }
        const launch = launchSnapshot(role)
        const reservation = this.childWorkspace?.reserve(ctx.sessionId, task.id)
        this.metric(ctx.sessionId, {
          metric: "dispatch",
          phase: "reservation",
          outcome: reservation ? "reserved" : "prepared",
          count: 1,
        })
        prepared.set(task.id, {
          dispatch: {
            run_id: runId,
            child_session_id: childSessionId,
            dispatched_at: nowIso(this.now),
            cancelled_at: null,
            role: profileSnapshot(role),
            launch,
            ...(reservation
              ? { workspace: dispatchWorkspaceMetadata(reservation), lifecycle: "reserved" as const }
              : {}),
          },
          brief,
          role: launch,
          reservation,
        })
      }
      if (prepared.size) {
        const result = await this.write(ctx, (latest) => {
          if (!latest)
            throw new PlanProtocolError({
              code: ERROR_CODES.INVALID_STATE,
              message: "当前 session 没有方案",
              hint: "先调用 Plan_create",
            })
          const next = clonePlan(latest)
          for (const [taskId, item] of prepared) {
            const target = next.steps.flatMap((step) => step.tasks).find((task) => task.id === taskId)
            if (!target || (target.status !== "pending" && target.status !== "rejected"))
              throw new PlanProtocolError({
                code: ERROR_CODES.INVALID_STATE,
                message: `任务 ${taskId} 在派发前状态已改变`,
                hint: "重新读取最新 plan 后再决定是否派发",
              })
            target.dispatch = item.dispatch
            target.status = "dispatched"
            if ((target.mode ?? "standard") === "standard") target.merge = emptyMergeRecord("pending")
          }
          next.revision++
          next.updated_at = nowIso(this.now)
          return {
            mutate(target) {
              Object.assign(target, next)
            },
            result: { next_action_hint: nextActionHint(next, this.inbox.pendingCount(ctx.sessionId)) },
          }
        })
        for (const [taskId, item] of prepared) {
          let actualChild = item.dispatch.child_session_id
          let workspaceHandle: WorkspaceHandle | undefined
          try {
            if (item.reservation && this.childWorkspace) {
              workspaceHandle = await this.childWorkspace.create(item.reservation)
              this.metric(ctx.sessionId, {
                metric: "dispatch",
                phase: "workspace",
                outcome: "created",
                duration_ms: Math.max(0, this.now() - Date.parse(item.dispatch.dispatched_at)),
              })
              await this.updateDispatchLifecycle(ctx, taskId, {
                workspace: dispatchWorkspaceMetadata(workspaceHandle),
              })
            }
            if (this.children) {
              const childBrief = workspaceHandle
                ? {
                    ...item.brief,
                    workspace_root: workspaceHandle.directory,
                    output_path: resolveInside(
                      workspaceHandle.directory,
                      path.relative(ctx.workspaceRoot, item.brief.output_path),
                      `浠诲姟 ${taskId} 鐨?child output_path`,
                    ),
                  }
                : item.brief
              const childInput: ChildStartInput = {
                parentSessionId: ctx.sessionId,
                taskId,
                childSessionId: actualChild,
                brief: childBrief,
                role: item.role,
                workspace: workspaceHandle
                  ? dispatchWorkspaceMetadata(workspaceHandle)
                  : item.dispatch.workspace,
              }
              actualChild = await this.children.create(childInput)
              this.metric(ctx.sessionId, {
                metric: "dispatch",
                phase: "create",
                outcome: "created",
                duration_ms: Math.max(0, this.now() - Date.parse(item.dispatch.dispatched_at)),
              })
              registerChildRun(actualChild, item.dispatch.run_id, ctx.workspaceRoot)
              await this.updateDispatchLifecycle(ctx, taskId, {
                child_session_id: actualChild,
                lifecycle: "child_created",
              })
              childInput.childSessionId = actualChild
              await this.updateDispatchLifecycle(ctx, taskId, { lifecycle: "starting" })
              await this.children.start(childInput)
              await this.updateDispatchLifecycle(ctx, taskId, { lifecycle: "running", status: "running" })
              this.metric(ctx.sessionId, {
                metric: "dispatch",
                phase: "start",
                outcome: "started",
                duration_ms: Math.max(0, this.now() - Date.parse(item.dispatch.dispatched_at)),
              })
            } else if (!this.childWorkspace) {
              // The convenience/default protocol may not have a runtime child
              // controller (for example, an embedded caller supplies the
              // child runner separately). Keep the durable task state
              // reportable instead of leaving it permanently dispatched.
              await this.updateDispatchLifecycle(ctx, taskId, { lifecycle: "running", status: "running" })
              this.metric(ctx.sessionId, { metric: "dispatch", phase: "start", outcome: "delegated", count: 1 })
            }
            dispatched.push({
              taskId,
              run_id: item.dispatch.run_id,
              child_session_id: actualChild,
              idempotent: false,
            })
          } catch (error) {
            this.metric(ctx.sessionId, { metric: "dispatch", phase: "start", outcome: "failed" })
            await this.failDispatch(ctx, {
              taskId,
              childSessionId: this.children ? actualChild : undefined,
              workspaceDirectory: workspaceHandle?.directory ?? item.dispatch.workspace?.directory,
              error,
            })
            throw error
          }
        }
        return { ok: true, dispatched, next_action_hint: result.result.next_action_hint }
      }
      return { ok: true, dispatched, next_action_hint: nextActionHint(plan, this.inbox.pendingCount(ctx.sessionId)) }
    } catch (error) {
      return responseFromError(error)
    }
  }

  async cancel(
    ctx: PlanExecutionContext,
    taskIds: unknown,
  ): Promise<
    ProtocolResponse<{
      cancelled: Array<{ taskId: string; terminated_child_session: string; new_status: "pending" }>
      next_action_hint: string
      termination_errors?: Array<{ taskId: string; child_session_id: string; message: string }>
    }>
  > {
    try {
      assertMain(ctx)
      assertMode(ctx, "multi", "Dispatch_cancel")
      if (
        !Array.isArray(taskIds) ||
        taskIds.length < 1 ||
        taskIds.length > 20 ||
        !taskIds.every((id) => typeof id === "string")
      )
        inputError("taskIds 必须是 1-20 个字符串")
      if (new Set(taskIds as string[]).size !== (taskIds as string[]).length) inputError("taskIds 不允许重复")
      const plan = this.store.read(this.path(ctx))
      if (!plan)
        throw new PlanProtocolError({
          code: ERROR_CODES.INVALID_STATE,
          message: "当前 session 没有方案",
          hint: "先调用 Plan_create",
        })
      const targets = (taskIds as string[]).map((id) => {
        const step = plan.steps.find((item) => item.tasks.some((task) => task.id === id))
        if (!step)
          throw new PlanProtocolError({
            code: ERROR_CODES.TASK_NOT_FOUND,
            message: `找不到任务 ${id}`,
            hint: `当前合法 taskId：${planTaskIds(plan).join("、")}`,
          })
        const task = step.tasks.find((item) => item.id === id)!
        if (!task.dispatch)
          throw new PlanProtocolError({
            code: ERROR_CODES.INVALID_STATE,
            message: `任务 ${id} 当前不可取消`,
            hint: "任务必须包含派发记录；已取消任务可以重复调用",
          })
        return task
      })
      const result = await this.write(ctx, (latest) => {
        if (!latest)
          throw new PlanProtocolError({
            code: ERROR_CODES.INVALID_STATE,
            message: "当前 session 没有方案",
            hint: "先调用 Plan_create",
          })
        const next = clonePlan(latest)
        const toTerminate: Array<{ taskId: string; child_session_id: string; workspace_directory?: string | null }> = []
        const cancelled = targets.map((source) => {
          const task = next.steps.flatMap((step) => step.tasks).find((item) => item.id === source.id)
          if (!task || !task.dispatch)
            throw new PlanProtocolError({
              code: ERROR_CODES.REVISION_CONFLICT,
              message: "任务在取消过程中发生变化",
              hint: "重新读取最新 plan 后重试",
            })
          if (task.dispatch.cancelled_at === null && task.status !== "dispatched" && task.status !== "running")
            throw new PlanProtocolError({
              code: ERROR_CODES.INVALID_STATE,
              message: `任务 ${task.id} 当前为 ${task.status}，不可取消终态任务`,
              hint: "reported/approved/dismissed 任务请使用 Plan_update(reopen_task) 并说明原因",
            })
          if (task.dispatch.cancelled_at === null)
            toTerminate.push({
              taskId: task.id,
              child_session_id: task.dispatch.child_session_id,
              workspace_directory: task.dispatch.workspace?.directory,
            })
          task.status = "pending"
          task.dispatch.cancelled_at = nowIso(this.now)
          return {
            taskId: task.id,
            terminated_child_session: task.dispatch.child_session_id,
            new_status: "pending" as const,
          }
        })
        next.revision++
        next.updated_at = nowIso(this.now)
        recomputeProgress(next, ctx.workspaceRoot)
        return {
          mutate(target) {
            Object.assign(target, next)
          },
          result: {
            cancelled,
            toTerminate,
            next_action_hint: nextActionHint(next, this.inbox.pendingCount(ctx.sessionId)),
          },
        }
      })
      const termination_errors: Array<{ taskId: string; child_session_id: string; message: string }> = []
      if (this.children) {
        for (const target of result.result.toTerminate) {
          try {
            await this.children.terminate(target.child_session_id)
          } catch (error) {
            termination_errors.push({
              ...target,
              message: error instanceof Error ? error.message : String(error),
            })
          }
        }
      }
      if (this.childWorkspace) {
        for (const target of result.result.toTerminate) {
          if (!target.workspace_directory) continue
          try {
            await this.childWorkspace.remove(target.workspace_directory)
          } catch (error) {
            termination_errors.push({
              taskId: target.taskId,
              child_session_id: target.child_session_id,
              message: `workspace cleanup: ${error instanceof Error ? error.message : String(error)}`,
            })
          }
        }
      }
      return {
        ok: true,
        cancelled: result.result.cancelled,
        next_action_hint: result.result.next_action_hint,
        ...(termination_errors.length > 0 ? { termination_errors } : {}),
      }
    } catch (error) {
      return responseFromError(error)
    }
  }

  async candidateDeclare(
    ctx: PlanExecutionContext,
    input: unknown,
  ): Promise<ProtocolResponse<{ phase: "declaring" | "cross_review"; declared: boolean }>> {
    try {
      const state = this.candidateChildState(ctx)
      const board = this.candidateBoardOrThrow()
      const value = validateCandidateDeclarationInput(input)
      if (state.step.candidate_discussion?.phase !== "declaring")
        throw new PlanProtocolError({
          code: ERROR_CODES.INVALID_STATE,
          message: "当前不在 declaring 阶段",
          hint: "等待候选讨论阶段开始",
        })
      const declarations = await board.candidateDeclarations({
        rootSessionID: state.parsed.parentSessionId,
        stepID: state.step.id,
      })
      if (declarations.some((item) => item.authorTaskID === state.task.id))
        throw new PlanProtocolError({
          code: ERROR_CODES.INVALID_STATE,
          message: "该 candidate 已完成声明",
          hint: "不要重复调用 Candidate_declare",
        })
      await board.postCandidateDeclaration({ sessionID: ctx.sessionId, ...value })
      const latestDeclarations = await board.candidateDeclarations({
        rootSessionID: state.parsed.parentSessionId,
        stepID: state.step.id,
      })
      const candidateTasks = state.step.tasks.filter((task) => task.mode === "candidate")
      const complete = candidateTasks.every((task) => latestDeclarations.some((item) => item.authorTaskID === task.id))
      if (!complete) return { ok: true, phase: "declaring", declared: true }
      const result = await this.write(state.parentContext, (latest) => {
        if (!latest)
          throw new PlanProtocolError({
            code: ERROR_CODES.RUN_NOT_FOUND,
            message: "找不到父 plan",
            hint: "候选 run 已失效",
          })
        const next = clonePlan(latest)
        const step = next.steps.find((item) => item.id === state.step.id)
        if (!step?.candidate_discussion || step.candidate_discussion.phase !== "declaring")
          throw new PlanProtocolError({
            code: ERROR_CODES.INVALID_STATE,
            message: "候选阶段已变化",
            hint: "重新读取 Plan",
          })
        step.candidate_discussion.phase = "cross_review"
        step.candidate_discussion.ready_task_ids = []
        next.revision++
        next.updated_at = nowIso(this.now)
        return {
          mutate(target) {
            Object.assign(target, next)
          },
          result: { phase: "cross_review" as const, declared: true },
        }
      })
      for (const candidate of candidateTasks) {
        const childID = candidate.dispatch?.child_session_id
        if (!childID) continue
        const event = this.publish({
          type: "check_point",
          session_id: childID,
          payload: { stepId: state.step.id, phase: "cross_review" },
        }) as WakeupEvent
        this.wakeups.push(event)
      }
      return { ok: true, ...result.result }
    } catch (error) {
      return responseFromError(error)
    }
  }

  async candidateReady(
    ctx: PlanExecutionContext,
    _input: unknown = {},
  ): Promise<
    ProtocolResponse<{ phase: "cross_review" | "awaiting_main"; ready: boolean; missing_task_ids?: string[] }>
  > {
    try {
      const state = this.candidateChildState(ctx)
      const board = this.candidateBoardOrThrow()
      if (state.step.candidate_discussion?.phase !== "cross_review")
        throw new PlanProtocolError({
          code: ERROR_CODES.INVALID_STATE,
          message: "当前不在 cross_review 阶段",
          hint: "先完成盲声明和同伴互评",
        })
      const coverage = await board.candidatePeerReplyCoverage({
        rootSessionID: state.parsed.parentSessionId,
        stepID: state.step.id,
        taskID: state.task.id,
      })
      if (!coverage.complete)
        throw new PlanProtocolError({
          code: ERROR_CODES.INVALID_STATE,
          message: `候选尚未回复所有同伴：${coverage.missingTaskIDs.join(", ")}`,
          hint: "对每个同伴的顶层声明直接回复后再调用 Candidate_ready",
        })
      const result = await this.write(state.parentContext, (latest) => {
        if (!latest)
          throw new PlanProtocolError({
            code: ERROR_CODES.RUN_NOT_FOUND,
            message: "找不到父 plan",
            hint: "候选 run 已失效",
          })
        const next = clonePlan(latest)
        const step = next.steps.find((item) => item.id === state.step.id)
        if (!step?.candidate_discussion || step.candidate_discussion.phase !== "cross_review")
          throw new PlanProtocolError({
            code: ERROR_CODES.INVALID_STATE,
            message: "候选阶段已变化",
            hint: "重新读取 Plan",
          })
        if (!step.candidate_discussion.ready_task_ids.includes(state.task.id))
          step.candidate_discussion.ready_task_ids.push(state.task.id)
        const allReady = step.tasks.every(
          (task) => task.mode === "candidate" && step.candidate_discussion!.ready_task_ids.includes(task.id),
        )
        if (allReady) step.candidate_discussion.phase = "awaiting_main"
        next.revision++
        next.updated_at = nowIso(this.now)
        return {
          mutate(target) {
            Object.assign(target, next)
          },
          result: {
            phase: (allReady ? "awaiting_main" : "cross_review") as "cross_review" | "awaiting_main",
            ready: true,
          },
        }
      })
      if (result.result.phase === "awaiting_main") {
        const event = this.publish({
          type: "check_point",
          session_id: state.parsed.parentSessionId,
          payload: { stepId: state.step.id, phase: "awaiting_main" },
        }) as WakeupEvent
        this.wakeups.push(event)
      }
      return { ok: true, ...result.result }
    } catch (error) {
      return responseFromError(error)
    }
  }

  async candidateBegin(
    ctx: PlanExecutionContext,
    _input: unknown = {},
  ): Promise<ProtocolResponse<{ phase: "running" }>> {
    try {
      assertMain(ctx)
      const plan = this.store.read(this.path(ctx))
      if (!plan)
        throw new PlanProtocolError({
          code: ERROR_CODES.INVALID_STATE,
          message: "当前 session 没有方案",
          hint: "先调用 Plan_create",
        })
      const step = plan.current_step ? findStep(plan, plan.current_step) : undefined
      if (!step?.candidate_discussion || step.candidate_discussion.phase !== "awaiting_main")
        throw new PlanProtocolError({
          code: ERROR_CODES.INVALID_STATE,
          message: "候选尚未全部 ready",
          hint: "等待所有候选 Candidate_ready",
        })
      if (
        !step.tasks.every(
          (task) => task.mode === "candidate" && step.candidate_discussion!.ready_task_ids.includes(task.id),
        )
      )
        throw new PlanProtocolError({
          code: ERROR_CODES.INVALID_STATE,
          message: "候选尚未全部 ready",
          hint: "等待所有候选 Candidate_ready",
        })
      const result = await this.write(ctx, (latest) => {
        if (!latest)
          throw new PlanProtocolError({
            code: ERROR_CODES.INVALID_STATE,
            message: "当前 session 没有方案",
            hint: "先调用 Plan_create",
          })
        const next = clonePlan(latest)
        const current = next.current_step ? findStep(next, next.current_step) : undefined
        if (!current?.candidate_discussion || current.candidate_discussion.phase !== "awaiting_main")
          throw new PlanProtocolError({
            code: ERROR_CODES.INVALID_STATE,
            message: "候选阶段已变化",
            hint: "重新读取 Plan",
          })
        current.candidate_discussion.phase = "running"
        next.revision++
        next.updated_at = nowIso(this.now)
        return {
          mutate(target) {
            Object.assign(target, next)
          },
          result: { phase: "running" as const },
        }
      })
      for (const candidate of step.tasks) {
        const childID = candidate.dispatch?.child_session_id
        if (!childID) continue
        const event = this.publish({
          type: "check_point",
          session_id: childID,
          payload: { stepId: step.id, phase: "running" },
        }) as WakeupEvent
        this.wakeups.push(event)
      }
      return { ok: true, ...result.result }
    } catch (error) {
      return responseFromError(error)
    }
  }

  async candidateSubmit(
    ctx: PlanExecutionContext,
    input: unknown,
  ): Promise<ProtocolResponse<{ review: "pending_review"; proposal_path: string }>> {
    try {
      const state = this.candidateChildState(ctx)
      const value = validateCandidateSubmitInput(input)
      if (value.runId !== ctx.runId)
        throw new PlanProtocolError({
          code: ERROR_CODES.RUN_STALE,
          message: "run_id 与当前候选 child 不一致",
          hint: "使用当前 dispatch 提供的 run_id",
        })
      if (state.step.candidate_discussion?.phase !== "running")
        throw new PlanProtocolError({
          code: ERROR_CODES.INVALID_STATE,
          message: "候选尚未开始独立执行",
          hint: "等待根会话调用 Candidate_begin",
        })
      const proposalPath = state.task.output_path
      if (!proposalPath)
        throw new PlanProtocolError({
          code: ERROR_CODES.INVALID_STATE,
          message: "candidate 缺少隔离提案路径",
          hint: "重新创建 candidate task",
        })
      const absolutePath = resolveInside(ctx.workspaceRoot, proposalPath, "candidate proposal")
      const expectedRoot = resolveInside(
        ctx.workspaceRoot,
        path.join(
          ".jyycode",
          "plan",
          state.parsed.parentSessionId,
          "candidates",
          state.step.id,
          state.task.id,
        ),
        "candidate output root",
      )
      assertInside(expectedRoot, absolutePath, "candidate proposal")
      if (path.basename(absolutePath) !== "proposal.md")
        throw new PlanProtocolError({
          code: ERROR_CODES.FORBIDDEN_CHILD_SESSION,
          message: "candidate 只能写入自己的隔离提案",
          hint: "不要提交自定义工作区路径",
        })
      fs.mkdirSync(path.dirname(absolutePath), { recursive: true })
      const temporary = `${absolutePath}.tmp-${process.pid}-${Date.now()}`
      fs.writeFileSync(temporary, value.proposal, "utf8")
      fs.renameSync(temporary, absolutePath)
      const result = await this.write(state.parentContext, (latest) => {
        if (!latest)
          throw new PlanProtocolError({
            code: ERROR_CODES.RUN_NOT_FOUND,
            message: "找不到父 plan",
            hint: "候选 run 已失效",
          })
        const next = clonePlan(latest)
        const task = next.steps.flatMap((step) => step.tasks).find((item) => item.id === state.task.id)
        if (!task || task.dispatch?.run_id !== ctx.runId || task.status !== "running")
          throw new PlanProtocolError({
            code: ERROR_CODES.RUN_STALE,
            message: "candidate task 状态已变化",
            hint: "停止重复提交",
          })
        task.report = {
          status: value.status as ReportStatus,
          summary: value.summary,
          artifacts: [absolutePath],
          issues: [],
          reported_at: nowIso(this.now),
          review_feedback: task.report?.review_feedback ?? null,
        }
        task.status = "reported"
        next.revision++
        next.updated_at = nowIso(this.now)
        return {
          mutate(target) {
            Object.assign(target, next)
          },
          result: { review: "pending_review" as const, proposal_path: absolutePath },
        }
      })
      const persisted = result.plan
      const reportStep = persisted.steps.find((step) => step.tasks.some((task) => task.id === state.task.id))
      const event = this.publish({
        type: "report_arrived",
        session_id: state.parsed.parentSessionId,
        revision: persisted.revision,
        payload: { stepId: reportStep?.id ?? persisted.current_step, taskId: state.task.id },
      }) as WakeupEvent
      this.wakeups.push(event)
      return { ok: true, ...result.result }
    } catch (error) {
      return responseFromError(error)
    }
  }

  async report(
    ctx: PlanExecutionContext,
    input: unknown,
  ): Promise<
    ProtocolResponse<{
      review: "pending_review" | "rejected_precheck" | "already_reported"
      message: string
    }>
  > {
    const startedAt = this.now()
    try {
      if (!ctx.runId)
        throw new PlanProtocolError({
          code: ERROR_CODES.FORBIDDEN_CHILD_SESSION,
          message: "主 session 不允许调用 Report",
          hint: "主 session 请用 Plan_update 推进状态",
        })
      if (!input || typeof input !== "object" || Array.isArray(input)) inputError("Report 入参必须是对象")
      const value = input as Record<string, unknown>
      assertOnly(value, ["run_id", "status", "summary", "artifacts", "issues"], "report")
      const runId = requiredText(value.run_id, "run_id")
      if (runId !== ctx.runId)
        throw new PlanProtocolError({
          code: ERROR_CODES.RUN_STALE,
          message: "携带的 run_id 与当前 child session 不一致",
          hint: "停止操作，不要重复汇报",
        })
      const parsed = parseRunId(runId)
      if (!parsed)
        throw new PlanProtocolError({
          code: ERROR_CODES.RUN_NOT_FOUND,
          message: "run_id 无法解析",
          hint: "请从启动简报原样复制 run_id",
        })
      const parentPlan = this.store.read(this.path(ctx, parsed.parentSessionId))
      const candidateTask = parentPlan?.steps.flatMap((step) => step.tasks).find((task) => task.id === parsed.taskId)
      if (candidateTask?.mode === "candidate")
        throw new PlanProtocolError({
          code: ERROR_CODES.FORBIDDEN_CHILD_SESSION,
          message: "candidate task must submit through Candidate_submit",
          hint: "Write the isolated proposal and call Candidate_submit with the same run_id.",
        })
      if (this.beforeReport) await this.beforeReport({ ...ctx, runId })
      const status = value.status
      if (!(status === "done" || status === "partial" || status === "failed"))
        inputError("status 必须是 done、partial 或 failed")
      const summary = requiredText(value.summary, "summary")
      const artifacts: string[] =
        value.artifacts === undefined
          ? []
          : Array.isArray(value.artifacts)
            ? value.artifacts.map((item) => requiredText(item, "artifacts[]"))
            : inputError("artifacts 必须是数组")
      const issues: string[] =
        value.issues === undefined
          ? []
          : Array.isArray(value.issues)
            ? value.issues.map((item) => requiredText(item, "issues[]"))
            : inputError("issues 必须是数组")
      if (status === "done" && artifacts.length === 0)
        inputError("status=done 时 artifacts 必填", "确认产出文件已写入 output_path 后，用同一 run_id 重新调用 Report")
      const reportPathCtx: PlanExecutionContext = { ...ctx, sessionId: parsed.parentSessionId, runId }
      const planPath = this.path(reportPathCtx)
      const attempt = (this.reportAttempts.get(runId) ?? 0) + 1
      const outputRoot = candidateTask?.output_path
        ? resolveInside(ctx.workspaceRoot, candidateTask.output_path, `任务 ${parsed.taskId} 的 output_path`)
        : undefined
      if (!outputRoot)
        throw new PlanProtocolError({
          code: ERROR_CODES.RUN_NOT_FOUND,
          message: "任务缺少 output_path",
          hint: "重新派发带有 output_path 的任务",
        })
      const canonicalArtifacts = artifacts.map((artifact) =>
        assertOutputArtifact({ workspaceRoot: ctx.workspaceRoot, outputRoot, artifact }),
      )
      const missing = canonicalArtifacts.filter((artifact) => !fs.existsSync(artifact))
      const shouldRejectPrecheck = missing.length > 0 && attempt >= REPORT_RETRY_MAX
      const result = await this.store.enqueueWrite<{
        review: "pending_review" | "rejected_precheck" | "already_reported"
        message: string
      }>(planPath, {
        priority: "normal",
        holder: ctx.sessionId,
        retryableOnTimeout: true,
        apply: (latest) => {
          if (!latest)
            throw new PlanProtocolError({
              code: ERROR_CODES.RUN_NOT_FOUND,
              message: "找不到父 plan.json",
              hint: "确认 run_id 来自有效的 Dispatch 简报",
            })
          const task = latest.steps.flatMap((step) => step.tasks).find((item) => item.id === parsed.taskId)
          if (!task || !task.dispatch)
            throw new PlanProtocolError({
              code: ERROR_CODES.RUN_NOT_FOUND,
              message: "run_id 没有关联任务",
              hint: "请从启动简报原样复制 run_id",
            })
          if (task.dispatch.run_id !== runId)
            throw new PlanProtocolError({
              code: ERROR_CODES.RUN_STALE,
              message: "该任务当前的 run_id 与你携带的不一致",
              hint: "你的 run 已被取消或替换，停止一切操作，不要重复汇报",
            })
          if (task.status === "reported" || task.status === "approved")
            return {
              mutate() {},
              result: {
                review: "already_reported" as const,
                message: "该 run_id 的报告已经受理，原报告保持不变。",
              },
            }
          if (task.status !== "running")
            throw new PlanProtocolError({
              code: ERROR_CODES.RUN_STALE,
              message: `任务当前为 ${task.status}，不能继续汇报`,
              hint: "停止使用已结束的 run_id；需要重做时重新派发任务",
            })
          if (missing.length && !shouldRejectPrecheck) {
            throw new PlanProtocolError({
              code: ERROR_CODES.SCHEMA_VALIDATION,
              message: `artifacts 文件不存在：${missing.join(", ")}`,
              hint: "补交：确认产出文件已写入 output_path 后，用同一 run_id 重新调用 Report 并带上 artifacts",
              retryable: true,
            })
          }
          const next = clonePlan(latest)
          const target = next.steps.flatMap((step) => step.tasks).find((item) => item.id === parsed.taskId)!
          const report: ReportRecord = {
            status: status as ReportStatus,
            summary,
            artifacts: canonicalArtifacts,
            issues,
            reported_at: nowIso(this.now),
            review_feedback: target.report?.review_feedback ?? null,
          }
          target.report = report
          target.status = shouldRejectPrecheck ? "rejected" : "reported"
          next.revision++
          next.updated_at = nowIso(this.now)
          return {
            mutate(targetPlan) {
              Object.assign(targetPlan, next)
            },
            result: {
              review: shouldRejectPrecheck ? ("rejected_precheck" as const) : ("pending_review" as const),
              message: shouldRejectPrecheck
                ? "汇报已记录，但未通过基础校验，已移交主 Agent Inbox。你的使命已完成，无需进一步操作。"
                : "汇报已受理，进入主 Agent 待审核队列。你的使命已完成，无需进一步操作。",
            },
          }
        },
      })
      this.reportAttempts.delete(runId)
      this.metric(parsed.parentSessionId, {
        metric: "report",
        phase: "submit",
        outcome: result.review === "already_reported" ? "idempotent" : result.review,
        duration_ms: Math.max(0, this.now() - startedAt),
      })
      const persisted = this.store.read(planPath)
      if (!persisted) throw new Error("Report 写入后无法读取父 plan")
      if (result.review === "already_reported") return { ok: true, ...result }
      if (result.review === "rejected_precheck")
        await this.cleanupTaskWorkspace({ ...ctx, sessionId: parsed.parentSessionId }, parsed.taskId)
      if (result.review === "pending_review") {
        const reportStep = persisted.steps.find((step) => step.tasks.some((task) => task.id === parsed.taskId))
        const snapshot = projectPlanSnapshot(persisted, {
          inboxPending: this.inbox.pendingCount(parsed.parentSessionId),
          activities: this.activities.get(parsed.parentSessionId),
        })
        this.publish({
          type: "plan.updated",
          session_id: parsed.parentSessionId,
          revision: persisted.revision,
          payload: snapshot,
        })
        const event = this.publish({
          type: "report_arrived",
          session_id: parsed.parentSessionId,
          revision: persisted.revision,
          payload: { stepId: reportStep?.id ?? persisted.current_step, taskId: parsed.taskId },
        }) as WakeupEvent
        this.wakeups.push(event)
      } else {
        this.inbox.add({
          session_id: parsed.parentSessionId,
          task_id: parsed.taskId,
          run_id: runId,
          kind: "report_precheck_failed",
          message: `Report 机审失败：${missing.join(", ")}`,
        })
        const snapshot = projectPlanSnapshot(persisted, {
          inboxPending: this.inbox.pendingCount(parsed.parentSessionId),
          activities: this.activities.get(parsed.parentSessionId),
        })
        this.publish({
          type: "plan.updated",
          session_id: parsed.parentSessionId,
          revision: persisted.revision,
          payload: snapshot,
        })
      }
      return { ok: true, ...result }
    } catch (error) {
      if (error instanceof PlanProtocolError) {
        this.metric(ctx.sessionId, {
          metric: "report",
          phase: "validation",
          outcome:
            error.code === ERROR_CODES.RUN_STALE || error.code === ERROR_CODES.RUN_NOT_FOUND ? "stale" : "rejected",
          duration_ms: Math.max(0, this.now() - startedAt),
        })
      }
      if (error instanceof PlanProtocolError && error.retryable && error.code !== ERROR_CODES.BLACKBOARD_UNREAD) {
        const runId =
          input && typeof input === "object" && typeof (input as Record<string, unknown>).run_id === "string"
            ? String((input as Record<string, unknown>).run_id)
            : undefined
        if (runId) this.reportAttempts.set(runId, (this.reportAttempts.get(runId) ?? 0) + 1)
      }
      return responseFromError(error)
    }
  }

  async merge(
    ctx: PlanExecutionContext,
    input: unknown,
  ): Promise<
    ProtocolResponse<{
      status: "merged" | "conflict" | "already_merged" | "failed"
      task_id: string
      applied_paths: string[]
      conflicts: Array<{
        path: string
        kind: string
        main_path?: string
        child_path?: string
        base_path?: string
      }>
      cleanup: string
      next_action_hint: string
    }>
  > {
    const startedAt = this.now()
    let mergeStarted = false
    try {
      assertMain(ctx)
      assertMode(ctx, "multi", "Merge.apply")
      validateMergeApplyInput(input)
      const value = input as MergeApplyInput
      const plan = this.store.read(this.path(ctx))
      if (!plan) throw new PlanProtocolError({ code: ERROR_CODES.INVALID_STATE, message: "plan not found", hint: "read the current Plan first" })
      const step = plan.steps.find((item) => item.tasks.some((task) => task.id === value.task_id))
      const task = step?.tasks.find((item) => item.id === value.task_id)
      if (!task || !step)
        throw new PlanProtocolError({
          code: ERROR_CODES.TASK_NOT_FOUND,
          message: `task not found: ${value.task_id}`,
          hint: "use a task_id from the current plan",
        })
      if ((task.mode ?? "standard") === "candidate")
        throw new PlanProtocolError({
          code: ERROR_CODES.INVALID_STATE,
          message: "candidate tasks are not merged through Merge.apply",
          hint: "complete candidate selection through the candidate workflow",
        })
      if (task.status !== "approved")
        throw new PlanProtocolError({
          code: ERROR_CODES.INVALID_STATE,
          message: `task ${task.id} must be approved before Merge.apply (current: ${task.status})`,
          hint: "review the Report first, then retry Merge.apply",
        })
      if (!task.dispatch || task.dispatch.cancelled_at !== null)
        throw new PlanProtocolError({
          code: ERROR_CODES.RUN_STALE,
          message: `task ${task.id} has no active dispatch workspace`,
          hint: "redispatch the task before merging it",
        })
      if (mergeStatus(task) === "merged") {
        return {
          ok: true,
          status: "already_merged",
          task_id: task.id,
          applied_paths: task.merge?.applied_paths ?? [],
          conflicts: task.merge?.conflicts ?? [],
          cleanup: task.merge?.cleanup ?? "completed",
          next_action_hint: "merge already completed; continue with the current Step",
        }
      }
      const workspace = task.dispatch.workspace
      if (!workspace)
        throw new PlanProtocolError({
          code: ERROR_CODES.INVALID_STATE,
          message: `task ${task.id} has no recorded child workspace`,
          hint: "dispatch the task with an isolated workspace before calling Merge.apply",
        })
      const mainRoot = path.resolve(ctx.workspaceRoot)
      if (path.resolve(workspace.root) !== mainRoot)
        throw new PlanProtocolError({
          code: ERROR_CODES.INVALID_STATE,
          message: "recorded workspace root does not match the current parent workspace",
          hint: "do not merge a workspace belonging to another project",
        })

      let baseDirectory: string | undefined
      let childDirectory: string | undefined
      let journalDirectory: string | null = null
      if (workspace.mode === "shared_compat") {
        if (!workspace.directory || path.resolve(workspace.directory) !== mainRoot)
          throw new PlanProtocolError({
            code: ERROR_CODES.INVALID_STATE,
            message: "shared compatibility workspace is not the parent workspace",
            hint: "refresh the recorded dispatch metadata before merging",
          })
      } else {
        const loaded = this.recordedWorkspace(ctx, task)
        baseDirectory = loaded?.baseline_directory ?? workspace.baseline_directory ?? undefined
        childDirectory = loaded?.directory ?? workspace.directory ?? undefined
        if (!baseDirectory || !childDirectory)
          throw new PlanProtocolError({
            code: ERROR_CODES.INVALID_STATE,
            message: "isolated task is missing baseline or child directory",
            hint: "preserve the recorded workspace and retry after recovery",
          })
        const baselineRoot = path.resolve(baseDirectory)
        const runtimeRoot = path.dirname(baselineRoot)
        const canonicalBaseline = fs.realpathSync.native(baselineRoot)
        const canonicalChild = fs.realpathSync.native(path.resolve(childDirectory))
        if (
          !pathWithin(runtimeRoot, canonicalBaseline) ||
          !pathWithin(runtimeRoot, canonicalChild) ||
          canonicalBaseline === canonicalChild ||
          canonicalChild === mainRoot
        )
          throw new PlanProtocolError({
            code: ERROR_CODES.INVALID_STATE,
            message: "recorded child/baseline paths are outside their owned runtime root",
            hint: "do not use a workspace path that was not created by this Task",
          })
        journalDirectory = task.merge?.journal_directory
          ? path.resolve(task.merge.journal_directory)
          : path.join(runtimeRoot, mergeJournalName(task.dispatch.run_id))
        if (!pathWithin(runtimeRoot, journalDirectory))
          throw new PlanProtocolError({
            code: ERROR_CODES.INVALID_STATE,
            message: "merge journal is outside the recorded runtime root",
            hint: "recreate the isolated Task workspace before retrying",
          })
      }

      if (workspace.mode === "shared_compat" && (value.paths?.length || value.resolutions?.length))
        inputError("paths and resolutions require an isolated task workspace")

      if (workspace.mode !== "shared_compat") {
        const preflight = planWorkspaceMerge({
          base: baseDirectory!,
          main: mainRoot,
          child: childDirectory!,
          paths: value.paths,
        })
        const currentConflicts = new Map(preflight.conflicts.map((conflict) => [conflict.path, conflict]))
        for (const resolution of value.resolutions ?? []) {
          const current = currentConflicts.get(resolution.path)
          if (!current) inputError(`resolution does not name an unresolved conflict: ${resolution.path}`)
          const previous = task.merge?.conflicts.find((conflict) => conflict.path === resolution.path)
          if (!previous || previous.fingerprint !== current.fingerprint)
            inputError(`resolution is stale for conflict: ${resolution.path}`, "re-read the conflict and retry with a current resolution")
        }
      }

      await this.write(ctx, (latest) => {
        if (!latest) throw new PlanProtocolError({ code: ERROR_CODES.INVALID_STATE, message: "plan not found", hint: "read the current plan" })
        const next = clonePlan(latest)
        const target = next.steps.flatMap((item) => item.tasks).find((item) => item.id === value.task_id)
        if (!target || target.status !== "approved" || target.dispatch?.run_id !== task.dispatch!.run_id)
          throw new PlanProtocolError({
            code: ERROR_CODES.RUN_STALE,
            message: "task changed while Merge.apply was preparing",
            hint: "read the latest plan and retry the current Task",
          })
        const merge = target.merge ? structuredClone(target.merge) : emptyMergeRecord()
        merge.status = "running"
        merge.attempt = Math.max(1, (target.merge?.attempt ?? 0) + (target.merge?.status === "running" ? 0 : 1))
        merge.started_at = merge.started_at ?? nowIso(this.now)
        merge.completed_at = null
        merge.cleanup = "pending"
        merge.journal_directory = journalDirectory
        merge.error = undefined
        target.merge = merge
        next.revision++
        next.updated_at = nowIso(this.now)
        return {
          mutate(targetPlan) {
            Object.assign(targetPlan, next)
          },
          result: { started: true },
        }
      })
      mergeStarted = true
      this.metric(ctx.sessionId, {
        metric: "merge",
        phase: "started",
        outcome: "running",
        duration_ms: Math.max(0, this.now() - startedAt),
      })

      let transaction: WorkspaceMergeTransactionResult
      if (workspace.mode === "shared_compat") {
        transaction = {
          status: "merged",
          applied_paths: [],
          conflicts: [],
          plan: { apply: [], keep: [], delete: [], conflicts: [] },
          journal_path: "",
          target_fingerprint: workspaceFingerprint(mainRoot),
        }
      } else {
        transaction = applyWorkspaceMerge({
          base: baseDirectory!,
          main: mainRoot,
          child: childDirectory!,
          paths: value.paths,
          resolutions: value.resolutions,
          journal_directory: journalDirectory!,
        })
      }

      const boundedConflicts = transaction.conflicts.slice(0, 50)
      const finalStatus = transaction.status === "conflict" ? "conflict" : transaction.status === "merged" || transaction.status === "already_merged" ? "merged" : "failed"
      await this.write(ctx, (latest) => {
        if (!latest) throw new PlanProtocolError({ code: ERROR_CODES.INVALID_STATE, message: "plan disappeared during Merge.apply", hint: "read the latest plan and retry" })
        const next = clonePlan(latest)
        const target = next.steps.flatMap((item) => item.tasks).find((item) => item.id === value.task_id)
        if (!target?.merge || target.dispatch?.run_id !== task.dispatch!.run_id)
          throw new PlanProtocolError({ code: ERROR_CODES.RUN_STALE, message: "task run changed during Merge.apply", hint: "stop and read the latest plan" })
        target.merge.status = finalStatus
        target.merge.applied_paths = [...new Set([...target.merge.applied_paths, ...transaction.applied_paths])].sort((left, right) => left.localeCompare(right))
        target.merge.conflicts = boundedConflicts
        target.merge.target_fingerprint = transaction.target_fingerprint
        target.merge.completed_at = nowIso(this.now)
        target.merge.error = transaction.error
        if (finalStatus !== "merged") target.merge.cleanup = "not_started"
        next.revision++
        next.updated_at = nowIso(this.now)
        recomputeProgress(next, ctx.workspaceRoot)
        return {
          mutate(targetPlan) {
            Object.assign(targetPlan, next)
          },
          result: { updated: true },
        }
      })

      if (finalStatus === "merged" && workspace.mode !== "shared_compat") {
        const cleanupErrors = await this.cleanupTaskWorkspace(ctx, task.id)
        await this.write(ctx, (latest) => {
          if (!latest) throw new Error("plan disappeared while recording merge cleanup")
          const next = clonePlan(latest)
          const target = next.steps.flatMap((item) => item.tasks).find((item) => item.id === task.id)
          if (target?.merge) {
            target.merge.cleanup = cleanupErrors.length ? "failed" : "completed"
            if (cleanupErrors.length) target.merge.cleanup_error = cleanupErrors.join("; ")
          }
          next.revision++
          next.updated_at = nowIso(this.now)
          return {
            mutate(targetPlan) {
              Object.assign(targetPlan, next)
            },
            result: { updated: true },
          }
        })
      } else if (finalStatus === "merged") {
        await this.write(ctx, (latest) => {
          if (!latest) throw new Error("plan disappeared while recording shared merge")
          const next = clonePlan(latest)
          const target = next.steps.flatMap((item) => item.tasks).find((item) => item.id === task.id)
          if (target?.merge) target.merge.cleanup = "completed"
          next.revision++
          next.updated_at = nowIso(this.now)
          return {
            mutate(targetPlan) {
              Object.assign(targetPlan, next)
            },
            result: { updated: true },
          }
        })
      }
      if (finalStatus === "conflict") {
        const conflictKey = boundedConflicts.map((conflict) => `${conflict.path}:${conflict.kind}:${conflict.fingerprint}`).join("|")
        this.inbox.add({
          session_id: ctx.sessionId,
          task_id: task.id,
          run_id: task.dispatch.run_id,
          kind: "merge_conflict",
          message: `Merge conflict for ${task.id}: ${boundedConflicts
            .map((conflict) => `${conflict.path} (${conflict.kind}) [${conflict.fingerprint}]`)
            .join(", ")}`,
          suggested_actions: [
            "inspect the reported main_path/base_path/child_path",
            "edit the parent file and retry Merge.apply with an explicit resolution",
          ],
        })
        const event = this.publish({
          type: "user_message",
          session_id: ctx.sessionId,
          payload: {
            kind: "merge_conflict",
            task_id: task.id,
            run_id: task.dispatch.run_id,
            conflicts: boundedConflicts,
            dedupe_key: `merge_conflict:${task.id}:${conflictKey}`,
          },
        }) as WakeupEvent
        this.wakeups.push(event)
      }
      const after = this.store.read(this.path(ctx))
      const mergedTask = after?.steps.flatMap((item) => item.tasks).find((item) => item.id === task.id)
      const status = transaction.status === "already_merged" ? "already_merged" : finalStatus
      this.metric(ctx.sessionId, {
        metric: "merge",
        phase: status === "conflict" ? "conflict" : status === "failed" ? "failed" : "completed",
        outcome: status,
        duration_ms: Math.max(0, this.now() - startedAt),
        count: transaction.applied_paths.length,
      })
      return {
        ok: true,
        status,
        task_id: task.id,
        applied_paths: transaction.applied_paths,
        conflicts: boundedConflicts,
        cleanup: mergedTask?.merge?.cleanup ?? "not_started",
        next_action_hint:
          status === "conflict"
            ? "inspect the conflict paths, edit main_path when needed, then retry Merge.apply with resolutions[{path,use:'main'|'child'}]"
            : status === "failed"
              ? "inspect the recorded merge journal and retry Merge.apply after fixing the reported failure"
              : "merge completed; continue with the current Step",
      }
    } catch (error) {
      if (mergeStarted)
        this.metric(ctx.sessionId, {
          metric: "merge",
          phase: "failed",
          outcome: "failed",
          duration_ms: Math.max(0, this.now() - startedAt),
        })
      return responseFromError(error)
    }
  }

  snapshot(ctx: PlanExecutionContext): PlanSnapshot | { plan: null } {
    const plan = this.store.read(this.path(ctx))
    return projectPlanSnapshot(plan, {
      inboxPending: this.inbox.pendingCount(ctx.sessionId),
      activities: this.activities.get(ctx.sessionId),
    })
  }

  recordActivity(input: {
    workspaceRoot: string
    parentSessionId: string
    taskId: string
    runId: string
    activity: string
    at?: string
    startedAt?: string
  }) {
    const map = this.activities.get(input.parentSessionId) ?? new Map<string, ActivityState>()
    const at = input.at ?? nowIso(this.now)
    map.set(input.taskId, { activity: input.activity, at, started_at: input.startedAt })
    this.activities.set(input.parentSessionId, map)
    const eventKey = `${input.parentSessionId}:${input.taskId}`
    const timestamp = Date.parse(at)
    const previous = this.activityEvents.get(eventKey)
    if (previous !== undefined && Number.isFinite(timestamp) && timestamp - previous < 1000) return
    if (Number.isFinite(timestamp)) this.activityEvents.set(eventKey, timestamp)
    return this.publish({
      type: "child.activity",
      session_id: input.parentSessionId,
      payload: { run_id: input.runId, activity: input.activity, elapsed_sec: 0 },
    })
  }

  /**
   * Align a task with a child run whose loop has terminated. A child that
   * exits without calling Report can never report again, so leaving its task
   * in running would deadlock the main agent on a report that will never
   * arrive; park the task as rejected so it can be redispatched or taken
   * over. The check is idempotent and run-scoped: superseded runs, cancelled
   * tasks, and tasks that already reported are left untouched.
   */
  async settleChildExit(input: {
    workspaceRoot: string
    parentSessionId: string
    childSessionId: string
    taskId: string
    runId: string
  }): Promise<{ settled: boolean; reason: string }> {
    const ctx: PlanExecutionContext = {
      workspaceRoot: input.workspaceRoot,
      sessionId: input.parentSessionId,
      mode: "multi",
    }
    const classify = (plan: PlanFile | null) => {
      if (!plan) return "plan_missing"
      const step = plan.steps.find((item) => item.tasks.some((task) => task.id === input.taskId))
      const task = step?.tasks.find((item) => item.id === input.taskId)
      if (!step || !task) return "task_missing"
      if (
        !task.dispatch ||
        task.dispatch.run_id !== input.runId ||
        task.dispatch.child_session_id !== input.childSessionId
      )
        return "stale_run"
      if (task.dispatch.cancelled_at !== null) return "cancelled"
      if (task.status !== "running" && task.status !== "dispatched") return "already_settled"
      // Candidate children intentionally end their turn while the discussion
      // waits on other candidates or on the main agent; only the independent
      // execution phase expects the loop to run until Candidate_submit.
      if ((task.mode ?? "standard") === "candidate" && step.candidate_discussion?.phase !== "running")
        return "candidate_waiting"
      return "settle"
    }
    const probe = classify(this.store.read(this.path(ctx)))
    if (probe !== "settle") return { settled: false, reason: probe }
    // Record the terminal activity before write() publishes its snapshot, so
    // the plan panel stops presenting the dead child as actively running.
    const map = this.activities.get(input.parentSessionId) ?? new Map<string, ActivityState>()
    map.set(input.taskId, { activity: "子 Agent 已停止", at: nowIso(this.now) })
    this.activities.set(input.parentSessionId, map)
    try {
      await this.write(ctx, (latest) => {
        const verdict = classify(latest)
        if (verdict !== "settle")
          throw new PlanProtocolError({
            code: ERROR_CODES.RUN_STALE,
            message: `child run 状态已变化：${verdict}`,
            hint: "该 run 已被其他流程处理，无需重复对齐",
          })
        const next = clonePlan(latest!)
        const task = next.steps.flatMap((step) => step.tasks).find((item) => item.id === input.taskId)!
        task.status = "rejected"
        next.revision++
        next.updated_at = nowIso(this.now)
        recomputeProgress(next, input.workspaceRoot)
        return {
          mutate(target) {
            Object.assign(target, next)
          },
          result: { settled: true },
        }
      })
      return { settled: true, reason: "child_exited" }
    } catch (error) {
      if (error instanceof PlanProtocolError && error.code === ERROR_CODES.RUN_STALE)
        return { settled: false, reason: "raced" }
      throw error
    }
  }

  drainWakeups(sessionId: string) {
    return this.wakeups.drain(sessionId)
  }

  replayWakeups(sessionId: string, afterSeq = -1) {
    const events = this.events
      .readAfter(sessionId, afterSeq)
      .filter((event): event is WakeupEvent =>
        event.type === "report_arrived" || event.type === "check_point" || event.type === "user_message",
      )
    for (const event of events) this.wakeups.push(event)
    return events
  }

  inboxEntries(ctx: PlanExecutionContext) {
    return this.inbox.list(ctx.sessionId)
  }
}

export const defaultPlanProtocol = new PlanProtocol()

/** Namespace-shaped convenience API mirroring the tool names in the protocol. */
export const Plan = {
  read: (ctx: PlanExecutionContext) => defaultPlanProtocol.read(ctx),
  create: (ctx: PlanExecutionContext, input: unknown) => defaultPlanProtocol.create(ctx, input),
  update: (ctx: PlanExecutionContext, input: unknown) => defaultPlanProtocol.update(ctx, input),
}

export const Inbox = {
  list: (ctx: PlanExecutionContext, input: unknown = {}) => defaultPlanProtocol.readInbox(ctx, input),
}

export const Dispatch = {
  dispatch: (ctx: PlanExecutionContext, input: unknown) => defaultPlanProtocol.dispatch(ctx, input),
  cancel: (ctx: PlanExecutionContext, taskIds: unknown) => defaultPlanProtocol.cancel(ctx, taskIds),
}

export const Report = {
  report: (ctx: PlanExecutionContext, input: unknown) => defaultPlanProtocol.report(ctx, input),
}

export const Candidate = {
  declare: (ctx: PlanExecutionContext, input: unknown) => defaultPlanProtocol.candidateDeclare(ctx, input),
  ready: (ctx: PlanExecutionContext, input: unknown = {}) => defaultPlanProtocol.candidateReady(ctx, input),
  begin: (ctx: PlanExecutionContext, input: unknown = {}) => defaultPlanProtocol.candidateBegin(ctx, input),
  submit: (ctx: PlanExecutionContext, input: unknown) => defaultPlanProtocol.candidateSubmit(ctx, input),
}

export * as PlanProtocolRuntime from "./protocol"
