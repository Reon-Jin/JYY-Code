import fs from "node:fs"
import path from "node:path"
import type { LaunchSnapshot, ProfileSnapshot } from "@/agent/subagent-profile"

export const ERROR_CODES = {
  SCHEMA_VALIDATION: "SCHEMA_VALIDATION",
  REVISION_CONFLICT: "REVISION_CONFLICT",
  INVALID_STATE: "INVALID_STATE",
  TASK_NOT_FOUND: "TASK_NOT_FOUND",
  STEP_NOT_FOUND: "STEP_NOT_FOUND",
  RUN_STALE: "RUN_STALE",
  RUN_NOT_FOUND: "RUN_NOT_FOUND",
  FORBIDDEN_CHILD_SESSION: "FORBIDDEN_CHILD_SESSION",
  DISPATCH_UNAVAILABLE: "DISPATCH_UNAVAILABLE",
  STEP_TASKS_EMPTY: "STEP_TASKS_EMPTY",
  PLAN_FINALIZED: "PLAN_FINALIZED",
  BLACKBOARD_UNREAD: "BLACKBOARD_UNREAD",
} as const

export type ErrorCode = (typeof ERROR_CODES)[keyof typeof ERROR_CODES]
export type PlanStatus = "draft" | "active" | "done"
export type StepStatus = "pending" | "active" | "done"
export type TaskStatus = "pending" | "dispatched" | "running" | "reported" | "approved" | "rejected"
export type ReportStatus = "done" | "partial" | "failed"

export type DispatchRecord = {
  run_id: string
  child_session_id: string
  dispatched_at: string
  cancelled_at: string | null
  role?: ProfileSnapshot
  launch?: LaunchSnapshot
}

export type ReportRecord = {
  status: ReportStatus
  summary: string
  artifacts: string[]
  issues: string[]
  reported_at: string
  review_feedback: string | null
}

export type PlanTask = {
  id: string
  title: string
  goal: string
  done_criteria: string
  output_path: string | null
  status: TaskStatus
  dispatch: DispatchRecord | null
  report: ReportRecord | null
}

export type PlanStep = {
  id: string
  title: string
  goal: string
  done_criteria: string
  status: StepStatus
  tasks: PlanTask[]
}

export type PlanFile = {
  title: string
  goal: string
  status: PlanStatus
  revision: number
  current_step: string | null
  steps: PlanStep[]
  created_at: string
  updated_at: string
}

export type CreateTaskInput = {
  title: string
  goal: string
  done_criteria: string
  output_path?: string
}

export type CreateStepInput = {
  title: string
  goal: string
  done_criteria: string
  tasks?: CreateTaskInput[]
}

export type CreatePlanInput = {
  title: string
  goal: string
  steps: CreateStepInput[]
}

export type PlanUpdateOp =
  | { op: "edit_plan"; fields: { title?: string; goal?: string } }
  | { op: "add_step"; after?: string; step: Omit<CreateStepInput, "tasks"> }
  | { op: "edit_step"; stepId: string; fields: { title?: string; goal?: string; done_criteria?: string } }
  | { op: "remove_step"; stepId: string }
  | { op: "add_task"; stepId: string; task: CreateTaskInput }
  | {
      op: "edit_task"
      stepId: string
      taskId: string
      fields: Partial<Pick<PlanTask, "title" | "goal" | "done_criteria" | "output_path">>
    }
  | { op: "remove_task"; stepId: string; taskId: string }
  | {
      op: "set_task_status"
      stepId: string
      taskId: string
      to: Exclude<TaskStatus, "dispatched" | "running"> | "running"
    }
  | { op: "review_task"; stepId: string; taskId: string; decision: "approve" | "reject"; feedback?: string }

export type PlanUpdateInput = { revision: number; ops: PlanUpdateOp[] }

export type PlanErrorDetails = {
  code: ErrorCode
  message: string
  hint: string
  retryable?: boolean
  latest_plan?: PlanFile
  latest_revision?: number
  rolled_back?: boolean
}

export type ProtocolErrorResponse = { ok: false; error: PlanErrorDetails }
export type ProtocolSuccess<T extends object = Record<string, unknown>> = { ok: true } & T
export type ProtocolResponse<T extends object = Record<string, unknown>> = ProtocolSuccess<T> | ProtocolErrorResponse

export class PlanProtocolError extends Error {
  readonly code: ErrorCode
  readonly hint: string
  readonly retryable: boolean
  readonly latestPlan?: PlanFile
  readonly latestRevision?: number
  readonly rolledBack?: boolean

  constructor(input: PlanErrorDetails) {
    super(input.message)
    this.name = "PlanProtocolError"
    this.code = input.code
    this.hint = input.hint
    this.retryable = input.retryable ?? false
    this.latestPlan = input.latest_plan
    this.latestRevision = input.latest_revision
    this.rolledBack = input.rolled_back
  }

  toResponse(): ProtocolErrorResponse {
    return {
      ok: false,
      error: {
        code: this.code,
        message: this.message,
        hint: this.hint,
        ...(this.retryable ? { retryable: true } : {}),
        ...(this.latestPlan ? { latest_plan: this.latestPlan } : {}),
        ...(this.latestRevision !== undefined ? { latest_revision: this.latestRevision } : {}),
        ...(this.rolledBack ? { rolled_back: true } : {}),
      },
    }
  }
}

export function protocolError(input: PlanErrorDetails): never {
  throw new PlanProtocolError(input)
}

export function isPlanProtocolError(error: unknown): error is PlanProtocolError {
  return error instanceof PlanProtocolError
}

export function responseFromError(error: unknown): ProtocolErrorResponse {
  if (isPlanProtocolError(error)) return error.toResponse()
  return {
    ok: false,
    error: {
      code: ERROR_CODES.SCHEMA_VALIDATION,
      message: error instanceof Error ? error.message : String(error),
      hint: "检查输入后重试",
    },
  }
}

export function planDirectory(workspaceRoot: string, sessionId: string) {
  if (!/^[A-Za-z0-9_-]+$/.test(sessionId)) {
    protocolError({
      code: ERROR_CODES.SCHEMA_VALIDATION,
      message: "sessionId 包含非法路径字符",
      hint: "sessionId 由运行时注入，必须只包含字母、数字、下划线或短横线",
    })
  }
  return path.join(workspaceRoot, ".jyycode", "plan", sessionId)
}

export function planFilePath(workspaceRoot: string, sessionId: string) {
  return path.join(planDirectory(workspaceRoot, sessionId), "plan.json")
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function nonEmptyString(value: unknown) {
  return typeof value === "string" && value.trim().length > 0
}

function validDateTime(value: unknown) {
  return typeof value === "string" && Number.isFinite(Date.parse(value))
}

function errorAt(pathname: string, message: string) {
  return `${pathname}: ${message}`
}

export function validatePlanFile(value: unknown): string[] {
  const errors: string[] = []
  if (!isRecord(value)) return ["plan: must be an object"]
  const allowed = new Set(["title", "goal", "status", "revision", "current_step", "steps", "created_at", "updated_at"])
  for (const key of Object.keys(value)) if (!allowed.has(key)) errors.push(errorAt(`plan.${key}`, "unknown property"))
  if (typeof value.title !== "string" || value.title.length < 1 || value.title.length > 60)
    errors.push(errorAt("plan.title", "must be 1-60 characters"))
  if (!nonEmptyString(value.goal)) errors.push(errorAt("plan.goal", "must be a non-empty string"))
  if (!["draft", "active", "done"].includes(String(value.status))) errors.push(errorAt("plan.status", "invalid status"))
  if (!Number.isInteger(value.revision) || (value.revision as number) < 1)
    errors.push(errorAt("plan.revision", "must be an integer >= 1"))
  if (value.current_step !== null && typeof value.current_step !== "string")
    errors.push(errorAt("plan.current_step", "must be string or null"))
  if (!Array.isArray(value.steps) || value.steps.length < 1)
    errors.push(errorAt("plan.steps", "must contain at least one step"))
  if (!validDateTime(value.created_at)) errors.push(errorAt("plan.created_at", "must be an ISO date-time"))
  if (!validDateTime(value.updated_at)) errors.push(errorAt("plan.updated_at", "must be an ISO date-time"))
  if (Array.isArray(value.steps)) {
    const stepIds = new Set<string>()
    for (const [index, rawStep] of value.steps.entries()) {
      const prefix = `plan.steps[${index}]`
      if (!isRecord(rawStep)) {
        errors.push(errorAt(prefix, "must be an object"))
        continue
      }
      const allowedStep = new Set(["id", "title", "goal", "done_criteria", "status", "tasks"])
      for (const key of Object.keys(rawStep))
        if (!allowedStep.has(key)) errors.push(errorAt(`${prefix}.${key}`, "unknown property"))
      if (!/^s[1-9]\d*$/.test(String(rawStep.id))) errors.push(errorAt(`${prefix}.id`, "invalid step id"))
      if (stepIds.has(String(rawStep.id))) errors.push(errorAt(`${prefix}.id`, "duplicate step id"))
      stepIds.add(String(rawStep.id))
      for (const field of ["title", "goal", "done_criteria"])
        if (!nonEmptyString(rawStep[field])) errors.push(errorAt(`${prefix}.${field}`, "must be non-empty"))
      if (!["pending", "active", "done"].includes(String(rawStep.status)))
        errors.push(errorAt(`${prefix}.status`, "invalid status"))
      if (!Array.isArray(rawStep.tasks)) {
        errors.push(errorAt(`${prefix}.tasks`, "must be an array"))
        continue
      }
      const taskIds = new Set<string>()
      for (const [taskIndex, rawTask] of rawStep.tasks.entries()) {
        const taskPrefix = `${prefix}.tasks[${taskIndex}]`
        if (!isRecord(rawTask)) {
          errors.push(errorAt(taskPrefix, "must be an object"))
          continue
        }
        const allowedTask = new Set([
          "id",
          "title",
          "goal",
          "done_criteria",
          "output_path",
          "status",
          "dispatch",
          "report",
        ])
        for (const key of Object.keys(rawTask))
          if (!allowedTask.has(key)) errors.push(errorAt(`${taskPrefix}.${key}`, "unknown property"))
        if (!/^s[1-9]\d*_t[1-9]\d*$/.test(String(rawTask.id)))
          errors.push(errorAt(`${taskPrefix}.id`, "invalid task id"))
        if (taskIds.has(String(rawTask.id))) errors.push(errorAt(`${taskPrefix}.id`, "duplicate task id"))
        taskIds.add(String(rawTask.id))
        for (const field of ["title", "goal", "done_criteria"])
          if (!nonEmptyString(rawTask[field])) errors.push(errorAt(`${taskPrefix}.${field}`, "must be non-empty"))
        if (!("output_path" in rawTask) || (rawTask.output_path !== null && typeof rawTask.output_path !== "string"))
          errors.push(errorAt(`${taskPrefix}.output_path`, "must be string or null"))
        if (!["pending", "dispatched", "running", "reported", "approved", "rejected"].includes(String(rawTask.status)))
          errors.push(errorAt(`${taskPrefix}.status`, "invalid status"))
        if (!("dispatch" in rawTask) || (rawTask.dispatch !== null && !isValidDispatch(rawTask.dispatch)))
          errors.push(errorAt(`${taskPrefix}.dispatch`, "invalid dispatch record"))
        if (!("report" in rawTask) || (rawTask.report !== null && !isValidReport(rawTask.report)))
          errors.push(errorAt(`${taskPrefix}.report`, "invalid report record"))
      }
    }
    if (value.current_step !== null && !stepIds.has(String(value.current_step)))
      errors.push(errorAt("plan.current_step", "must reference an existing step"))
  }
  return errors
}

function isValidDispatch(value: unknown): value is DispatchRecord {
  if (!isRecord(value)) return false
  const role = value.role
  const validRole =
    role === undefined ||
    (isRecord(role) &&
      nonEmptyString(role.id) &&
      nonEmptyString(role.name) &&
      nonEmptyString(role.description) &&
      ["bot", "search", "code", "bug", "chart", "file", "image", "folder", "pen", "sparkles"].includes(
        String(role.avatar),
      ))
  const launch = value.launch
  const validLaunch =
    launch === undefined ||
    (validRole &&
      isRecord(launch) &&
      typeof launch.prompt === "string" &&
      (!("model" in launch) || typeof launch.model === "string") &&
      (!("variant" in launch) || typeof launch.variant === "string"))
  return (
    /^run__[A-Za-z0-9_-]+__s[1-9]\d*_t[1-9]\d*$/.test(String(value.run_id)) &&
    nonEmptyString(value.child_session_id) &&
    validDateTime(value.dispatched_at) &&
    (value.cancelled_at === null || validDateTime(value.cancelled_at)) &&
    validRole &&
    validLaunch
  )
}

function isValidReport(value: unknown): value is ReportRecord {
  if (!isRecord(value)) return false
  return (
    ["done", "partial", "failed"].includes(String(value.status)) &&
    nonEmptyString(value.summary) &&
    Array.isArray(value.artifacts) &&
    value.artifacts.every((item) => typeof item === "string") &&
    Array.isArray(value.issues) &&
    value.issues.every((item) => typeof item === "string") &&
    validDateTime(value.reported_at) &&
    (value.review_feedback === null || typeof value.review_feedback === "string")
  )
}

export function assertPlanFile(value: unknown): asserts value is PlanFile {
  const errors = validatePlanFile(value)
  if (errors.length) {
    protocolError({
      code: ERROR_CODES.SCHEMA_VALIDATION,
      message: `plan.json 校验失败：${errors.join("；")}`,
      hint: "修复 plan.json 后重试",
    })
  }
}

export function clonePlan(plan: PlanFile): PlanFile {
  return structuredClone(plan)
}

export function readPlanFileSync(planPath: string): PlanFile | null {
  if (!fs.existsSync(planPath)) return null
  let parsed: unknown
  try {
    parsed = JSON.parse(fs.readFileSync(planPath, "utf8"))
  } catch (error) {
    protocolError({
      code: ERROR_CODES.SCHEMA_VALIDATION,
      message: `无法解析 ${planPath}: ${error instanceof Error ? error.message : String(error)}`,
      hint: "恢复或删除损坏的 plan.json 后重试",
    })
  }
  assertPlanFile(parsed)
  return parsed
}

export * as PlanSchema from "./schema"
