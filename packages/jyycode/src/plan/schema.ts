import fs from "node:fs"
import path from "node:path"
import type { LaunchSnapshot, ProfileSnapshot } from "@/agent/subagent-profile"
import type { CleanupRecord } from "./workspace-cleanup"

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
  WORKSPACE_QUOTA_EXCEEDED: "WORKSPACE_QUOTA_EXCEEDED",
} as const

export type ErrorCode = (typeof ERROR_CODES)[keyof typeof ERROR_CODES]
export type PlanStatus = "draft" | "active" | "done"
export type StepStatus = "pending" | "active" | "done"
export type PlanTaskMode = "standard" | "candidate"
export type TaskStatus = "pending" | "dispatched" | "running" | "reported" | "approved" | "rejected" | "dismissed"
export type ReportStatus = "done" | "partial" | "failed"
export type CandidateDiscussionPhase = "declaring" | "cross_review" | "awaiting_main" | "running"

export type CandidateDiscussion = {
  phase: CandidateDiscussionPhase
  ready_task_ids: string[]
}

export type CandidateSelection = {
  selected_task_id: string
  contributing_task_ids: string[]
  synthesis_artifact: string
  rationale: string
  selected_at: string
}

export type MergeStatus = "not_started" | "pending" | "running" | "merged" | "conflict" | "failed"
export type MergeConflictKind = "content" | "add_add" | "delete_modify" | "binary" | "symlink"
export type MergeCleanupStatus = "not_started" | "pending" | "completed" | "failed"

export type MergeConflictSummary = {
  path: string
  kind: MergeConflictKind
  main_path?: string
  child_path?: string
  base_path?: string
  fingerprint?: string
}

export type MergeResolution = {
  path: string
  use: "main" | "child"
}

export type MergeRecord = {
  status: MergeStatus
  attempt: number
  applied_paths: string[]
  conflicts: MergeConflictSummary[]
  started_at: string | null
  completed_at: string | null
  target_fingerprint: string | null
  cleanup: MergeCleanupStatus
  journal_directory?: string | null
  error?: string
  cleanup_error?: string
  cleanup_record?: CleanupRecord
}

export type WorkspaceBaseline = {
  baseline_directory?: string | null
  baseline_manifest_path?: string | null
  baseline_manifest_hash?: string | null
  baseline_manifest_size?: number | null
  baseline_manifest_file_count?: number | null
  baseline_id?: string | null
  source_manifest_hash?: string | null
  source_revision?: string | null
}

export type DispatchWorkspace = WorkspaceBaseline & {
  mode: "worktree" | "snapshot" | "shared_compat"
  root: string
  directory: string | null
  created_at: string | null
  cleanup: "on_success" | "on_cancel" | "retain_on_failure"
}

export type DispatchLifecycle = "reserved" | "child_created" | "starting" | "running" | "settled"

export type DispatchRecord = {
  run_id: string
  child_session_id: string
  dispatched_at: string
  cancelled_at: string | null
  role?: ProfileSnapshot
  launch?: LaunchSnapshot
  workspace?: DispatchWorkspace
  lifecycle?: DispatchLifecycle
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
  /** Detailed execution context carried into the dispatched child brief. */
  instructions?: string
  output_path: string | null
  /** Legacy in-memory fixtures may omit this; persisted plans are normalized to standard. */
  mode?: PlanTaskMode
  status: TaskStatus
  dispatch: DispatchRecord | null
  report: ReportRecord | null
  merge?: MergeRecord
  reopen_reason?: string
}

export type PlanStep = {
  id: string
  title: string
  goal: string
  done_criteria: string
  status: StepStatus
  tasks: PlanTask[]
  candidate_discussion?: CandidateDiscussion
  candidate_selection?: CandidateSelection
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
  instructions?: string
  output_path?: string
  mode?: PlanTaskMode
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
      fields: Partial<Pick<PlanTask, "title" | "goal" | "done_criteria" | "instructions" | "output_path">>
    }
  | { op: "remove_task"; stepId: string; taskId: string }
  | { op: "reopen_task"; stepId: string; taskId: string; reason: string }
  | {
      op: "set_task_status"
      stepId: string
      taskId: string
      to: Exclude<TaskStatus, "dispatched" | "running"> | "running"
    }
  | { op: "review_task"; stepId: string; taskId: string; decision: "approve" | "reject"; feedback?: string }
  | {
      op: "select_candidate"
      stepId: string
      selectedTaskId: string
      contributingTaskIds?: string[]
      synthesisArtifact: string
      rationale: string
    }

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

function validCandidateDiscussion(value: unknown): value is CandidateDiscussion {
  if (!isRecord(value)) return false
  return (
    ["declaring", "cross_review", "awaiting_main", "running"].includes(String(value.phase)) &&
    Array.isArray(value.ready_task_ids) &&
    value.ready_task_ids.every((item) => typeof item === "string")
  )
}

function validCandidateSelection(value: unknown): value is CandidateSelection {
  if (!isRecord(value)) return false
  return (
    nonEmptyString(value.selected_task_id) &&
    Array.isArray(value.contributing_task_ids) &&
    value.contributing_task_ids.every((item) => typeof item === "string") &&
    nonEmptyString(value.synthesis_artifact) &&
    nonEmptyString(value.rationale) &&
    validDateTime(value.selected_at)
  )
}

function isValidMergeConflict(value: unknown): value is MergeConflictSummary {
  if (!isRecord(value)) return false
  return (
    nonEmptyString(value.path) &&
    ["content", "add_add", "delete_modify", "binary", "symlink"].includes(String(value.kind)) &&
    (value.main_path === undefined || nonEmptyString(value.main_path)) &&
    (value.child_path === undefined || nonEmptyString(value.child_path)) &&
    (value.base_path === undefined || nonEmptyString(value.base_path)) &&
    (value.fingerprint === undefined || nonEmptyString(value.fingerprint))
  )
}

function isValidCleanupRecord(value: unknown): value is CleanupRecord {
  if (!isRecord(value)) return false
  if (!["pending", "stopping", "deleting", "failed", "quarantined", "completed"].includes(String(value.state)))
    return false
  if (!Number.isSafeInteger(value.attempts) || Number(value.attempts) < 0) return false
  if (!validDateTime(value.updated_at)) return false
  if (value.next_retry_at !== undefined && !validDateTime(value.next_retry_at)) return false
  if (value.last_error !== undefined) {
    if (
      !isRecord(value.last_error) ||
      !nonEmptyString(value.last_error.phase) ||
      !nonEmptyString(value.last_error.message)
    )
      return false
    if (value.last_error.code !== undefined && !nonEmptyString(value.last_error.code)) return false
  }
  return true
}

function isValidMerge(value: unknown): value is MergeRecord {
  if (!isRecord(value)) return false
  return (
    ["not_started", "pending", "running", "merged", "conflict", "failed"].includes(String(value.status)) &&
    Number.isInteger(value.attempt) &&
    (value.attempt as number) >= 0 &&
    Array.isArray(value.applied_paths) &&
    value.applied_paths.every((item) => nonEmptyString(item)) &&
    Array.isArray(value.conflicts) &&
    value.conflicts.every(isValidMergeConflict) &&
    (value.started_at === null || validDateTime(value.started_at)) &&
    (value.completed_at === null || validDateTime(value.completed_at)) &&
    (value.target_fingerprint === null || nonEmptyString(value.target_fingerprint)) &&
    ["not_started", "pending", "completed", "failed"].includes(String(value.cleanup)) &&
    (value.journal_directory === undefined ||
      value.journal_directory === null ||
      nonEmptyString(value.journal_directory)) &&
    (value.error === undefined || nonEmptyString(value.error)) &&
    (value.cleanup_error === undefined || nonEmptyString(value.cleanup_error)) &&
    (value.cleanup_record === undefined || isValidCleanupRecord(value.cleanup_record))
  )
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
      const allowedStep = new Set([
        "id",
        "title",
        "goal",
        "done_criteria",
        "status",
        "tasks",
        "candidate_discussion",
        "candidate_selection",
      ])
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
      const taskModes = rawStep.tasks.filter(isRecord).map((task) => (task.mode === undefined ? "standard" : task.mode))
      const hasCandidates = taskModes.includes("candidate")
      if (
        hasCandidates &&
        (taskModes.some((mode) => mode !== "candidate") || taskModes.length < 2 || taskModes.length > 3)
      )
        errors.push(
          errorAt(`${prefix}.tasks`, "candidate steps must contain 2-3 candidate tasks and no standard tasks"),
        )
      if (hasCandidates) {
        const outputPaths = new Set<string>()
        for (const [taskIndex, rawTask] of rawStep.tasks.entries()) {
          if (!isRecord(rawTask) || rawTask.mode !== "candidate") continue
          if (rawTask.output_path !== null && typeof rawTask.output_path === "string") {
            if (outputPaths.has(rawTask.output_path))
              errors.push(errorAt(`${prefix}.tasks[${taskIndex}].output_path`, "duplicate candidate output path"))
            outputPaths.add(rawTask.output_path)
          }
        }
        if (rawStep.candidate_discussion === undefined)
          errors.push(errorAt(`${prefix}.candidate_discussion`, "candidate tasks require discussion metadata"))
        else if (!validCandidateDiscussion(rawStep.candidate_discussion))
          errors.push(errorAt(`${prefix}.candidate_discussion`, "invalid candidate discussion"))
        if (rawStep.candidate_selection !== undefined && !validCandidateSelection(rawStep.candidate_selection))
          errors.push(errorAt(`${prefix}.candidate_selection`, "invalid candidate selection"))
      } else if (rawStep.candidate_discussion !== undefined || rawStep.candidate_selection !== undefined) {
        errors.push(errorAt(prefix, "candidate metadata requires candidate tasks"))
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
          "instructions",
          "output_path",
          "mode",
          "status",
          "dispatch",
          "report",
          "merge",
          "reopen_reason",
        ])
        for (const key of Object.keys(rawTask))
          if (!allowedTask.has(key)) errors.push(errorAt(`${taskPrefix}.${key}`, "unknown property"))
        if (!/^s[1-9]\d*_t[1-9]\d*$/.test(String(rawTask.id)))
          errors.push(errorAt(`${taskPrefix}.id`, "invalid task id"))
        if (taskIds.has(String(rawTask.id))) errors.push(errorAt(`${taskPrefix}.id`, "duplicate task id"))
        taskIds.add(String(rawTask.id))
        for (const field of ["title", "goal", "done_criteria"])
          if (!nonEmptyString(rawTask[field])) errors.push(errorAt(`${taskPrefix}.${field}`, "must be non-empty"))
        if (rawTask.instructions !== undefined && !nonEmptyString(rawTask.instructions))
          errors.push(errorAt(`${taskPrefix}.instructions`, "must be a non-empty string when provided"))
        if (rawTask.reopen_reason !== undefined && !nonEmptyString(rawTask.reopen_reason))
          errors.push(errorAt(`${taskPrefix}.reopen_reason`, "must be a non-empty string when provided"))
        if (!("output_path" in rawTask) || (rawTask.output_path !== null && typeof rawTask.output_path !== "string"))
          errors.push(errorAt(`${taskPrefix}.output_path`, "must be string or null"))
        if (rawTask.mode !== undefined && !["standard", "candidate"].includes(String(rawTask.mode)))
          errors.push(errorAt(`${taskPrefix}.mode`, "invalid mode"))
        if (
          !["pending", "dispatched", "running", "reported", "approved", "rejected", "dismissed"].includes(
            String(rawTask.status),
          )
        )
          errors.push(errorAt(`${taskPrefix}.status`, "invalid status"))
        if (!("dispatch" in rawTask) || (rawTask.dispatch !== null && !isValidDispatch(rawTask.dispatch)))
          errors.push(errorAt(`${taskPrefix}.dispatch`, "invalid dispatch record"))
        if (!("report" in rawTask) || (rawTask.report !== null && !isValidReport(rawTask.report)))
          errors.push(errorAt(`${taskPrefix}.report`, "invalid report record"))
        if (rawTask.merge !== undefined && !isValidMerge(rawTask.merge))
          errors.push(errorAt(`${taskPrefix}.merge`, "invalid merge record"))
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
  const workspace = value.workspace
  const validWorkspace =
    workspace === undefined ||
    (isRecord(workspace) &&
      ["worktree", "snapshot", "shared_compat"].includes(String(workspace.mode)) &&
      nonEmptyString(workspace.root) &&
      (workspace.directory === null || nonEmptyString(workspace.directory)) &&
      (workspace.created_at === null || validDateTime(workspace.created_at)) &&
      ["on_success", "on_cancel", "retain_on_failure"].includes(String(workspace.cleanup)) &&
      (workspace.baseline_directory === undefined ||
        workspace.baseline_directory === null ||
        nonEmptyString(workspace.baseline_directory)) &&
      (workspace.baseline_manifest_path === undefined ||
        workspace.baseline_manifest_path === null ||
        nonEmptyString(workspace.baseline_manifest_path)) &&
      (workspace.baseline_manifest_hash === undefined ||
        workspace.baseline_manifest_hash === null ||
        nonEmptyString(workspace.baseline_manifest_hash)) &&
      (workspace.baseline_manifest_size === undefined ||
        workspace.baseline_manifest_size === null ||
        (Number.isSafeInteger(workspace.baseline_manifest_size) && Number(workspace.baseline_manifest_size) >= 0)) &&
      (workspace.baseline_manifest_file_count === undefined ||
        workspace.baseline_manifest_file_count === null ||
        (Number.isSafeInteger(workspace.baseline_manifest_file_count) &&
          Number(workspace.baseline_manifest_file_count) >= 0)) &&
      (workspace.baseline_id === undefined ||
        workspace.baseline_id === null ||
        nonEmptyString(workspace.baseline_id)) &&
      (workspace.source_manifest_hash === undefined ||
        workspace.source_manifest_hash === null ||
        nonEmptyString(workspace.source_manifest_hash)) &&
      (workspace.source_revision === undefined ||
        workspace.source_revision === null ||
        nonEmptyString(workspace.source_revision)))
  return (
    /^run__[A-Za-z0-9_-]+__s[1-9]\d*_t[1-9]\d*$/.test(String(value.run_id)) &&
    nonEmptyString(value.child_session_id) &&
    validDateTime(value.dispatched_at) &&
    (value.cancelled_at === null || validDateTime(value.cancelled_at)) &&
    validRole &&
    validLaunch &&
    validWorkspace &&
    (value.lifecycle === undefined ||
      ["reserved", "child_created", "starting", "running", "settled"].includes(String(value.lifecycle)))
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

/** Normalize persisted plans at the read boundary so old standard tasks remain valid. */
export function normalizePlanFile(value: unknown): unknown {
  if (!isRecord(value)) return value
  const normalized = structuredClone(value) as Record<string, unknown>
  if (Array.isArray(normalized.steps)) {
    normalized.steps = normalized.steps.map((step) => {
      if (!isRecord(step) || !Array.isArray(step.tasks)) return step
      return {
        ...step,
        tasks: step.tasks.map((task) => {
          if (!isRecord(task)) return task
          const normalizedTask: Record<string, unknown> = {
            ...task,
            ...(task.mode === undefined ? { mode: "standard" } : {}),
          }
          if (isRecord(normalizedTask.merge) && normalizedTask.merge.cleanup_record === undefined) {
            const merge = normalizedTask.merge
            const state =
              merge.cleanup === "completed" ? "completed" : merge.cleanup === "failed" ? "failed" : "pending"
            normalizedTask.merge = {
              ...merge,
              cleanup_record: {
                state,
                attempts: 0,
                updated_at:
                  typeof merge.completed_at === "string"
                    ? merge.completed_at
                    : typeof normalized.updated_at === "string"
                      ? normalized.updated_at
                      : new Date(0).toISOString(),
                ...(typeof merge.cleanup_error === "string"
                  ? { last_error: { phase: "legacy", message: merge.cleanup_error } }
                  : {}),
              },
            }
          }
          return normalizedTask
        }),
      }
    })
  }
  return normalized
}

export function mergeStatus(task: PlanTask): MergeStatus {
  return task.merge?.status ?? "not_started"
}

function pathWithin(workspace: string, candidate: string) {
  const relative = path.relative(path.resolve(workspace), path.resolve(candidate))
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative))
}

export function isStepComplete(step: PlanStep, workspace: string): boolean {
  const isCandidate = step.tasks.some((task) => task.mode === "candidate")
  if (!isCandidate)
    return (
      step.tasks.length > 0 &&
      step.tasks.every(
        (task) => task.status === "approved" && (!task.dispatch?.workspace || mergeStatus(task) === "merged"),
      )
    )
  if (step.tasks.length < 2 || step.tasks.length > 3 || step.tasks.some((task) => task.mode !== "candidate"))
    return false
  const selection = step.candidate_selection
  if (!selection) return false
  const synthesisPath = path.resolve(workspace, selection.synthesis_artifact)
  if (!pathWithin(workspace, synthesisPath) || !fs.existsSync(synthesisPath)) return false
  const selected = step.tasks.find((task) => task.id === selection.selected_task_id)
  return (
    !!selected &&
    selected.status === "approved" &&
    selected.report?.status === "done" &&
    step.tasks.filter((task) => task.status === "approved").length === 1 &&
    step.tasks.filter((task) => task.status === "dismissed").length === step.tasks.length - 1
  )
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
  const normalized = normalizePlanFile(parsed)
  assertPlanFile(normalized)
  return normalized
}

export * as PlanSchema from "./schema"
