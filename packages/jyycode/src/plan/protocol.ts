import fs from "node:fs"
import path from "node:path"
import {
  ERROR_CODES,
  PlanProtocolError,
  clonePlan,
  planFilePath,
  responseFromError,
  type CreatePlanInput,
  type CreateStepInput,
  type CreateTaskInput,
  type DispatchRecord,
  type PlanFile,
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
}

export type ChildController = {
  create(input: ChildStartInput): Promise<string>
  start(input: ChildStartInput): Promise<void>
  terminate(sessionId: string): Promise<void>
}

export type DispatchBrief = {
  run_id: string
  goal: string
  done_criteria: string
  output_path: string
  report_format: string
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
const sharedReportAttempts = new Map<string, number>()
const sharedActivities = new Map<string, Map<string, ActivityState>>()
const sharedActivityEvents = new Map<string, number>()

export function registerChildRun(childSessionId: string, runId: string) {
  childRunRegistry.set(childSessionId, runId)
}

export function runIdForChildSession(childSessionId: string) {
  return childRunRegistry.get(childSessionId)
}

type ProtocolOptions = {
  store?: PlanStore
  events?: PlanEventHub
  wakeups?: WakeupQueue
  inbox?: PlanInbox
  children?: ChildController
  now?: () => number
  eventSink?: (event: import("./events").PlanEvent) => void
}

type WriteResult<T extends object> = { result: T; plan: PlanFile }

function asString(value: unknown) {
  return typeof value === "string" ? value.trim() : ""
}

function nowIso(now: () => number) {
  return new Date(now()).toISOString()
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

function assertOnly(value: Record<string, unknown>, allowed: readonly string[], prefix: string) {
  const allowedSet = new Set(allowed)
  const extra = Object.keys(value).find((key) => !allowedSet.has(key))
  if (extra) inputError(`${prefix}.${extra} 不允许出现`, "删除未定义字段后重试")
}

function validateCreateInput(input: unknown): asserts input is CreatePlanInput {
  if (!input || typeof input !== "object" || Array.isArray(input)) inputError("Plan.create 入参必须是对象")
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
        "只有 steps[0] 可以携带 tasks；后续阶段用 Plan.update(add_task) 展开",
      )
    }
    for (const [taskIndex, rawTask] of (Array.isArray(step.tasks) ? step.tasks : []).entries()) {
      if (!rawTask || typeof rawTask !== "object" || Array.isArray(rawTask))
        inputError(`steps[${index}].tasks[${taskIndex}] 必须是对象`)
      const task = rawTask as Record<string, unknown>
      assertOnly(task, ["title", "goal", "done_criteria", "output_path"], `steps[${index}].tasks[${taskIndex}]`)
      requiredText(task.title, `steps[${index}].tasks[${taskIndex}].title`)
      requiredText(task.goal, `steps[${index}].tasks[${taskIndex}].goal`)
      requiredText(task.done_criteria, `steps[${index}].tasks[${taskIndex}].done_criteria`)
      if (task.output_path !== undefined && !asString(task.output_path))
        inputError(`steps[${index}].tasks[${taskIndex}].output_path 必须是非空字符串`)
    }
  }
}

function validateUpdateInput(input: unknown): asserts input is PlanUpdateInput {
  if (!input || typeof input !== "object" || Array.isArray(input)) inputError("Plan.update 入参必须是对象")
  const value = input as Record<string, unknown>
  assertOnly(value, ["revision", "ops"], "update")
  if (!Number.isInteger(value.revision) || Number(value.revision) < 1) inputError("revision 必须是正整数")
  if (!Array.isArray(value.ops) || value.ops.length < 1 || value.ops.length > 50) inputError("ops 必须包含 1-50 个操作")
  for (const [index, rawOp] of (value.ops as unknown[]).entries()) {
    if (!rawOp || typeof rawOp !== "object" || Array.isArray(rawOp)) inputError(`ops[${index}] 必须是对象`)
    const op = rawOp as Record<string, unknown>
    if (op.op === "review_task" && op.decision === "reject" && !asString(op.feedback))
      inputError(`ops[${index}] reject 必须提供 feedback`, "补充具体的验收缺口后重试")
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
  }
  for (const task of plan.steps.flatMap((step) => step.tasks)) counts[task.status]++
  return counts
}

function nextActionHint(plan: PlanFile, inboxPending: number) {
  if (inboxPending > 0) return `有 ${inboxPending} 个异常待处理：先处理 Inbox`
  const reported = plan.steps.flatMap((step) => step.tasks).filter((task) => task.status === "reported")
  if (reported.length) return `有 ${reported.length} 个任务待审核：${reported.map((task) => task.id).join("、")}`
  const current = plan.current_step ? plan.steps.find((step) => step.id === plan.current_step) : undefined
  if (!current) return "方案已完成，可向用户交付总结"
  if (current.tasks.length === 0) return `${current.id} 当前没有任务，请用 Plan.update(add_task) 展开明细`
  const pending = current.tasks.filter((task) => task.status === "pending" || task.status === "rejected")
  if (pending.length) return `${current.id} 有 ${pending.length} 个 pending/rejected 任务，可开始派发或执行`
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

function recomputeProgress(plan: PlanFile) {
  let currentIndex = plan.steps.findIndex(
    (step) => !(step.tasks.length > 0 && step.tasks.every((task) => task.status === "approved")),
  )
  if (currentIndex < 0) currentIndex = plan.steps.length
  plan.steps.forEach((step, index) => {
    const done = step.tasks.length > 0 && step.tasks.every((task) => task.status === "approved")
    step.status = done ? "done" : index === currentIndex ? "active" : "pending"
  })
  plan.current_step = currentIndex < plan.steps.length ? plan.steps[currentIndex]!.id : null
  plan.status = currentIndex >= plan.steps.length ? "done" : "active"
}

function createTask(input: CreateTaskInput, id: string): PlanTask {
  return {
    id,
    title: requiredText(input.title, "task.title"),
    goal: requiredText(input.goal, "task.goal"),
    done_criteria: requiredText(input.done_criteria, "task.done_criteria"),
    output_path: input.output_path ? asString(input.output_path) : null,
    status: "pending",
    dispatch: null,
    report: null,
  }
}

function createStep(input: CreateStepInput, id: string, tasks: PlanTask[] = []): PlanStep {
  return {
    id,
    title: requiredText(input.title, "step.title"),
    goal: requiredText(input.goal, "step.goal"),
    done_criteria: requiredText(input.done_criteria, "step.done_criteria"),
    status: "pending",
    tasks,
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
      const id = nextTaskId(step)
      step.tasks.push(createTask(op.task, id))
      assigned.tasks.push(id)
      return
    }
    case "edit_task": {
      const { task } = findTask(plan, op.stepId, op.taskId)
      if (!(task.status === "pending" || task.status === "rejected")) {
        throw new PlanProtocolError({
          code: ERROR_CODES.INVALID_STATE,
          message: `任务 ${task.id} 当前为 ${task.status}，不允许 edit_task`,
          hint: "执行中任务先 Dispatch.cancel 再 edit",
        })
      }
      if (op.fields.title !== undefined) task.title = requiredText(op.fields.title, "title")
      if (op.fields.goal !== undefined) task.goal = requiredText(op.fields.goal, "goal")
      if (op.fields.done_criteria !== undefined)
        task.done_criteria = requiredText(op.fields.done_criteria, "done_criteria")
      if (op.fields.output_path !== undefined) task.output_path = requiredText(op.fields.output_path, "output_path")
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
    default:
      inputError(`不支持的操作 ${(op as { op?: unknown }).op ?? "（缺失）"}`)
  }
}

function parseRunId(runId: string) {
  const match = /^run__(.+)__(s[1-9]\d*_t[1-9]\d*)$/.exec(runId)
  return match ? { parentSessionId: match[1]!, taskId: match[2]! } : undefined
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
  private readonly now: () => number
  private readonly eventSink?: (event: import("./events").PlanEvent) => void
  private readonly reportAttempts = sharedReportAttempts
  private readonly activities = sharedActivities
  private readonly activityEvents = sharedActivityEvents

  constructor(options: ProtocolOptions = {}) {
    this.store = options.store ?? defaultPlanStore
    this.events = options.events ?? defaultPlanEvents
    this.wakeups = options.wakeups ?? defaultWakeupQueue
    this.inbox = options.inbox ?? defaultPlanInbox
    this.children = options.children
    this.now = options.now ?? Date.now
    this.eventSink = options.eventSink
  }

  private publish(event: Parameters<PlanEventHub["publish"]>[0]) {
    const result = this.events.publish(event)
    this.eventSink?.(result)
    return result
  }

  private path(ctx: PlanExecutionContext, sessionId = ctx.sessionId) {
    return planFilePath(ctx.workspaceRoot, sessionId)
  }

  private async write<T extends object>(
    ctx: PlanExecutionContext,
    apply: (latest: PlanFile | null) => WriteOutcome<T>,
  ): Promise<WriteResult<T>> {
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
                "检查任务定义与 output_path，必要时用 Plan.update(edit_task) 修正后重新 dispatch",
                "主 Agent 直接执行该任务并用 Plan.update 推进状态",
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
            hint: "已有方案，请用 Plan.update 修改",
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
            return createTask(task, taskId)
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
        recomputeProgress(plan)
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
      const assigned = { steps: [] as string[], tasks: [] as string[] }
      const reviewed: Array<{ taskId: string; result: "approved" | "rejected" }> = []
      const result = await this.write(ctx, (latest) => {
        if (!latest)
          throw new PlanProtocolError({
            code: ERROR_CODES.INVALID_STATE,
            message: "当前 session 没有方案",
            hint: "先调用 Plan.create 创建方案",
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
              applyOp(draft, op, ctx.mode, assigned, reviewed)
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
        recomputeProgress(draft)
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
      return { ok: true, ...result.result }
    } catch (error) {
      return responseFromError(error)
    }
  }

  async dispatch(
    ctx: PlanExecutionContext,
    taskIds: unknown,
  ): Promise<
    ProtocolResponse<{
      dispatched: Array<{ taskId: string; run_id: string; child_session_id: string; idempotent: boolean }>
      next_action_hint: string
    }>
  > {
    try {
      assertMain(ctx)
      assertMode(ctx, "multi", "Dispatch.dispatch")
      if (
        !Array.isArray(taskIds) ||
        taskIds.length < 1 ||
        taskIds.length > 20 ||
        !taskIds.every((id) => typeof id === "string" && /^s[1-9]\d*_t[1-9]\d*$/.test(id))
      )
        inputError("taskIds 必须是 1-20 个合法 taskId")
      if (new Set(taskIds as string[]).size !== (taskIds as string[]).length) inputError("taskIds 不允许重复")
      const plan = this.store.read(this.path(ctx))
      if (!plan)
        throw new PlanProtocolError({
          code: ERROR_CODES.INVALID_STATE,
          message: "当前 session 没有方案",
          hint: "先调用 Plan.create",
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
      const dispatched: Array<{ taskId: string; run_id: string; child_session_id: string; idempotent: boolean }> = []
      const prepared = new Map<string, { dispatch: DispatchRecord; brief: DispatchBrief }>()
      for (const { task } of targets) {
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
        const runId = `run__${ctx.sessionId}__${task.id}`
        const childSessionId = `child_${ctx.sessionId}_${task.id}`
        const brief: DispatchBrief = {
          run_id: runId,
          goal: task.goal,
          done_criteria: task.done_criteria,
          output_path: task.output_path!,
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
        const childInput = { parentSessionId: ctx.sessionId, taskId: task.id, childSessionId, brief }
        const actualChild = this.children ? await this.children.create(childInput) : childSessionId
        registerChildRun(actualChild, runId)
        prepared.set(task.id, {
          dispatch: {
            run_id: runId,
            child_session_id: actualChild,
            dispatched_at: nowIso(this.now),
            cancelled_at: null,
          },
          brief,
        })
      }
      if (prepared.size) {
        const result = await this.write(ctx, (latest) => {
          if (!latest)
            throw new PlanProtocolError({
              code: ERROR_CODES.INVALID_STATE,
              message: "当前 session 没有方案",
              hint: "先调用 Plan.create",
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
            target.status = this.children ? "running" : "dispatched"
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
        if (this.children) {
          for (const [taskId, item] of prepared) {
            await this.children.start({
              parentSessionId: ctx.sessionId,
              taskId,
              childSessionId: item.dispatch.child_session_id,
              brief: item.brief,
            })
          }
        }
        for (const [taskId, item] of prepared)
          dispatched.push({
            taskId,
            run_id: item.dispatch.run_id,
            child_session_id: item.dispatch.child_session_id,
            idempotent: false,
          })
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
    ProtocolResponse<{ cancelled: Array<{ taskId: string; terminated_child_session: string; new_status: "pending" }> }>
  > {
    try {
      assertMain(ctx)
      assertMode(ctx, "multi", "Dispatch.cancel")
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
          hint: "先调用 Plan.create",
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
        if (
          !(task.status === "dispatched" || task.status === "running" || task.status === "reported") ||
          !task.dispatch
        )
          throw new PlanProtocolError({
            code: ERROR_CODES.INVALID_STATE,
            message: `任务 ${id} 当前不可取消`,
            hint: "仅允许取消 dispatched、running 或 reported 任务",
          })
        return task
      })
      for (const task of targets) if (this.children) await this.children.terminate(task.dispatch!.child_session_id)
      const result = await this.write(ctx, (latest) => {
        if (!latest)
          throw new PlanProtocolError({
            code: ERROR_CODES.INVALID_STATE,
            message: "当前 session 没有方案",
            hint: "先调用 Plan.create",
          })
        const next = clonePlan(latest)
        const cancelled = targets.map((source) => {
          const task = next.steps.flatMap((step) => step.tasks).find((item) => item.id === source.id)
          if (!task || !task.dispatch)
            throw new PlanProtocolError({
              code: ERROR_CODES.REVISION_CONFLICT,
              message: "任务在取消过程中发生变化",
              hint: "重新读取最新 plan 后重试",
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
        return {
          mutate(target) {
            Object.assign(target, next)
          },
          result: { cancelled },
        }
      })
      return { ok: true, ...result.result }
    } catch (error) {
      return responseFromError(error)
    }
  }

  async report(
    ctx: PlanExecutionContext,
    input: unknown,
  ): Promise<ProtocolResponse<{ review: "pending_review" | "rejected_precheck"; message: string }>> {
    try {
      if (!ctx.runId)
        throw new PlanProtocolError({
          code: ERROR_CODES.FORBIDDEN_CHILD_SESSION,
          message: "主 session 不允许调用 Report",
          hint: "主 session 请用 Plan.update 推进状态",
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
      const missing = artifacts.filter(
        (artifact) => !fs.existsSync(path.isAbsolute(artifact) ? artifact : path.resolve(ctx.workspaceRoot, artifact)),
      )
      const shouldRejectPrecheck = missing.length > 0 && attempt >= REPORT_RETRY_MAX
      const result = await this.store.enqueueWrite(planPath, {
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
            artifacts,
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
      const persisted = this.store.read(planPath)
      if (!persisted) throw new Error("Report 写入后无法读取父 plan")
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
      if (error instanceof PlanProtocolError && error.retryable) {
        const runId =
          input && typeof input === "object" && typeof (input as Record<string, unknown>).run_id === "string"
            ? String((input as Record<string, unknown>).run_id)
            : undefined
        if (runId) this.reportAttempts.set(runId, (this.reportAttempts.get(runId) ?? 0) + 1)
      }
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

  drainWakeups(sessionId: string) {
    return this.wakeups.drain(sessionId)
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
  dispatch: (ctx: PlanExecutionContext, taskIds: unknown) => defaultPlanProtocol.dispatch(ctx, taskIds),
  cancel: (ctx: PlanExecutionContext, taskIds: unknown) => defaultPlanProtocol.cancel(ctx, taskIds),
}

export const Report = {
  report: (ctx: PlanExecutionContext, input: unknown) => defaultPlanProtocol.report(ctx, input),
}

export * as PlanProtocolRuntime from "./protocol"
