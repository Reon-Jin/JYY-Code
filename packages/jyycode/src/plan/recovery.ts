import fs from "node:fs"
import path from "node:path"
import { clonePlan, planFilePath, type DispatchRecord, type PlanFile, type PlanTask } from "./schema"
import { PlanStore, defaultPlanStore } from "./store"
import { PlanInbox, defaultPlanInbox } from "./events"
import { childTerminationRequest, type ChildController } from "./protocol"
import { ChildWorkspace } from "./child-workspace"
import {
  applyWorkspaceMerge,
  removeMergeJournal,
  workspaceFingerprint,
  type WorkspaceMergeTransactionResult,
} from "./workspace-merge"

export type RecoveryResult = {
  sessionId: string
  continued: string[]
  rejected: string[]
  settled: string[]
  errors: string[]
}

export type RecoveryObservation = {
  sessionId: string
  taskId?: string
  phase: "reconcile" | "resume" | "reject" | "settle"
  outcome: "continued" | "rejected" | "settled" | "error"
}

export type RecoveryResumeInput = {
  sessionId: string
  task: PlanTask
  dispatch: DispatchRecord
  phase: "reserved" | "child_created" | "starting"
}

export type RecoveryOptions = {
  workspaceRoot: string
  store?: PlanStore
  inbox?: PlanInbox
  children?: ChildController
  childWorkspace?: ChildWorkspace
  now?: () => number
  startingTimeoutMs?: number
  isChildActive?: (sessionId: string) => Promise<boolean>
  resume?: (input: RecoveryResumeInput) => Promise<{ childSessionId?: string; started: boolean }>
  observe?: (observation: RecoveryObservation) => void
}

function nowIso(now: () => number) {
  return new Date(now()).toISOString()
}

function dispatchLifecycle(dispatch: DispatchRecord) {
  return dispatch.lifecycle ?? (dispatch.cancelled_at ? "settled" : undefined)
}

function taskPath(workspaceRoot: string, sessionId: string) {
  return planFilePath(workspaceRoot, sessionId)
}

const MERGE_CONFLICT_LIMIT = 50

function pathWithin(root: string, target: string) {
  const relative = path.relative(path.resolve(root), path.resolve(target))
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative))
}

export class PlanRecovery {
  private readonly workspaceRoot: string
  private readonly store: PlanStore
  private readonly inbox: PlanInbox
  private readonly children?: ChildController
  private readonly childWorkspace?: ChildWorkspace
  private readonly now: () => number
  private readonly startingTimeoutMs: number
  private readonly isChildActive: (sessionId: string) => Promise<boolean>
  private readonly resume?: RecoveryOptions["resume"]
  private readonly observe?: RecoveryOptions["observe"]

  constructor(options: RecoveryOptions) {
    this.workspaceRoot = path.resolve(options.workspaceRoot)
    this.store = options.store ?? defaultPlanStore
    this.inbox = options.inbox ?? defaultPlanInbox
    this.children = options.children
    this.childWorkspace = options.childWorkspace
    this.now = options.now ?? Date.now
    this.startingTimeoutMs = options.startingTimeoutMs ?? 30_000
    this.isChildActive = options.isChildActive ?? (async () => false)
    this.resume = options.resume
    this.observe = options.observe
  }

  private record(observation: Omit<RecoveryObservation, "sessionId"> & { sessionId?: string }) {
    this.observe?.({ ...observation, sessionId: observation.sessionId ?? "" })
  }

  private async update(sessionId: string, taskId: string, apply: (task: PlanTask, plan: PlanFile) => void) {
    const filename = taskPath(this.workspaceRoot, sessionId)
    await this.store.enqueueWrite(filename, {
      priority: "high",
      holder: sessionId,
      retryableOnTimeout: false,
      apply: (latest) => {
        if (!latest) throw new Error(`plan not found for ${sessionId}`)
        const next = clonePlan(latest)
        const task = next.steps.flatMap((step) => step.tasks).find((item) => item.id === taskId)
        if (!task) throw new Error(`task not found: ${taskId}`)
        apply(task, next)
        next.revision++
        next.updated_at = nowIso(this.now)
        return {
          mutate(target) {
            Object.assign(target, next)
          },
          result: { updated: true },
        }
      },
    })
  }

  private async reject(sessionId: string, task: PlanTask, reason: string, result: RecoveryResult) {
    const childSessionId = task.dispatch?.child_session_id
    const workspaceDirectory = task.dispatch?.workspace?.directory
    const cleanupErrors: string[] = []
    let childStopped = !childSessionId
    try {
      if (childSessionId && !this.children) throw new Error("child termination coordinator unavailable")
      if (childSessionId && this.children) {
        const termination = await this.children.terminate(
          childSessionId,
          childTerminationRequest(task.dispatch?.workspace),
        )
        if (termination?.state === "stop_failed")
          cleanupErrors.push(`child cleanup: ${termination.phase}: ${termination.message}`)
        else childStopped = true
      }
    } catch (error) {
      cleanupErrors.push(`child cleanup: ${error instanceof Error ? error.message : String(error)}`)
    }
    try {
      if (childStopped && workspaceDirectory && this.childWorkspace && task.dispatch?.workspace?.mode !== "shared_compat")
        await this.childWorkspace.remove(workspaceDirectory)
    } catch (error) {
      cleanupErrors.push(`workspace cleanup: ${error instanceof Error ? error.message : String(error)}`)
    }
    try {
      await this.update(sessionId, task.id, (current) => {
        current.status = "rejected"
        if (current.dispatch) current.dispatch.lifecycle = "settled"
      })
      result.rejected.push(task.id)
      this.record({ sessionId, taskId: task.id, phase: "reject", outcome: "rejected" })
    } catch (error) {
      result.errors.push(`${task.id}: ${error instanceof Error ? error.message : String(error)}`)
      this.record({ sessionId, taskId: task.id, phase: "reject", outcome: "error" })
    }
    this.inbox.add({
      session_id: sessionId,
      task_id: task.id,
      run_id: task.dispatch?.run_id,
      kind: "runtime_error",
      message: `Recovery rejected ${task.id}: ${[reason, ...cleanupErrors].join("; ")}`,
      suggested_actions: ["read Inbox", "reopen the task with an explicit reason before redispatching"],
    })
  }

  private async cleanupMergeWorkspace(sessionId: string, task: PlanTask) {
    const workspace = task.dispatch?.workspace
    if (!workspace || workspace.mode === "shared_compat") return
    if (!this.childWorkspace) throw new Error("child workspace manager unavailable")
    if (!workspace.directory || !workspace.baseline_directory)
      throw new Error("recorded child/baseline directory is missing")
    const runtimeRoot = path.dirname(path.resolve(workspace.baseline_directory))
    const childDirectory = path.resolve(workspace.directory)
    const baselineDirectory = path.resolve(workspace.baseline_directory)
    if (
      path.resolve(workspace.root) !== this.workspaceRoot ||
      !pathWithin(runtimeRoot, childDirectory) ||
      !pathWithin(runtimeRoot, baselineDirectory)
    )
      throw new Error("recorded merge workspace is outside the owning runtime root")
    if (!fs.existsSync(childDirectory) || !fs.existsSync(baselineDirectory))
      throw new Error("recorded merge workspace is missing")
    const canonicalChild = fs.realpathSync.native(childDirectory)
    const canonicalBaseline = fs.realpathSync.native(baselineDirectory)
    if (
      !pathWithin(runtimeRoot, canonicalChild) ||
      !pathWithin(runtimeRoot, canonicalBaseline) ||
      canonicalChild === canonicalBaseline
    )
      throw new Error("recorded merge workspace resolves outside the owning runtime root")
    const reservation = this.childWorkspace.reserve(sessionId, task.id)
    const loaded = this.childWorkspace.load({
      ...reservation,
      ...workspace,
      rootSessionId: sessionId,
      taskId: task.id,
      name: reservation.name,
      directory: canonicalChild,
      baseline_directory: canonicalBaseline,
    })
    if (!loaded || path.resolve(loaded.directory) !== path.resolve(childDirectory))
      throw new Error("recorded child workspace could not be reconstructed")
    await this.childWorkspace.remove(loaded.directory)
    if (task.merge?.journal_directory) removeMergeJournal(task.merge.journal_directory, runtimeRoot)
  }

  private async recordMergeFailure(sessionId: string, taskId: string, reason: string, result: RecoveryResult) {
    try {
      await this.update(sessionId, taskId, (current) => {
        if (!current.merge) return
        current.merge.status = "failed"
        current.merge.cleanup = "not_started"
        current.merge.completed_at = nowIso(this.now)
        current.merge.error = reason
      })
    } catch (error) {
      result.errors.push(`${taskId}: ${error instanceof Error ? error.message : String(error)}`)
    }
    result.errors.push(`${taskId}: ${reason}`)
    this.inbox.add({
      session_id: sessionId,
      task_id: taskId,
      run_id: undefined,
      kind: "runtime_error",
      message: `Merge recovery failed for ${taskId}: ${reason}`,
      suggested_actions: [
        "read the merge journal and current Plan",
        "preserve the recorded child workspace before retrying",
      ],
    })
    this.record({ sessionId, taskId, phase: "reconcile", outcome: "error" })
  }

  private async reconcileMerge(sessionId: string, task: PlanTask, result: RecoveryResult) {
    const merge = task.merge
    if (!merge) return false
    if (
      merge.status === "conflict" ||
      merge.status === "failed" ||
      merge.status === "pending" ||
      merge.status === "not_started"
    )
      return false

    if (merge.status === "merged") {
      if (merge.cleanup === "completed" || task.dispatch?.workspace?.mode === "shared_compat") return false
      try {
        await this.cleanupMergeWorkspace(sessionId, task)
        await this.update(sessionId, task.id, (current) => {
          if (current.merge) {
            current.merge.cleanup = "completed"
            current.merge.cleanup_error = undefined
          }
        })
        result.settled.push(task.id)
        this.record({ sessionId, taskId: task.id, phase: "settle", outcome: "settled" })
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error)
        await this.update(sessionId, task.id, (current) => {
          if (current.merge) {
            current.merge.cleanup = "failed"
            current.merge.cleanup_error = reason
          }
        }).catch((updateError) =>
          result.errors.push(`${task.id}: ${updateError instanceof Error ? updateError.message : String(updateError)}`),
        )
        result.errors.push(`${task.id}: cleanup failed: ${reason}`)
        this.inbox.add({
          session_id: sessionId,
          task_id: task.id,
          run_id: task.dispatch?.run_id,
          kind: "merge_cleanup_failed",
          message: `Merge cleanup failed for ${task.id}: ${reason}`,
          suggested_actions: [
            "inspect the exact recorded child/baseline paths",
            "retry cleanup after fixing the workspace service",
          ],
        })
        this.record({ sessionId, taskId: task.id, phase: "settle", outcome: "error" })
      }
      return true
    }

    const dispatch = task.dispatch
    const workspace = dispatch?.workspace
    if (!dispatch || !workspace || dispatch.cancelled_at !== null || dispatch.lifecycle === "settled") {
      await this.recordMergeFailure(sessionId, task.id, "merge run is stale or was cancelled", result)
      return true
    }

    let transaction: WorkspaceMergeTransactionResult
    try {
      if (workspace.mode === "shared_compat") {
        transaction = {
          status: "merged",
          applied_paths: [],
          conflicts: [],
          plan: { apply: [], keep: [], delete: [], conflicts: [] },
          journal_path: "",
          target_fingerprint: workspaceFingerprint(this.workspaceRoot),
        }
      } else {
        if (!workspace.directory || !workspace.baseline_directory || !merge.journal_directory)
          throw new Error("running merge is missing durable workspace or journal metadata")
        const runtimeRoot = path.dirname(path.resolve(workspace.baseline_directory))
        const journalDirectory = path.resolve(merge.journal_directory)
        const childDirectory = path.resolve(workspace.directory)
        const baselineDirectory = path.resolve(workspace.baseline_directory)
        if (
          path.resolve(workspace.root) !== this.workspaceRoot ||
          !pathWithin(runtimeRoot, childDirectory) ||
          !pathWithin(runtimeRoot, baselineDirectory) ||
          !pathWithin(runtimeRoot, journalDirectory)
        )
          throw new Error("running merge paths are outside the owning runtime root")
        transaction = applyWorkspaceMerge({
          base: baselineDirectory,
          main: this.workspaceRoot,
          child: childDirectory,
          journal_directory: journalDirectory,
        })
      }
    } catch (error) {
      await this.recordMergeFailure(sessionId, task.id, error instanceof Error ? error.message : String(error), result)
      return true
    }

    const boundedConflicts = transaction.conflicts.slice(0, MERGE_CONFLICT_LIMIT)
    const status =
      transaction.status === "conflict"
        ? "conflict"
        : transaction.status === "merged" || transaction.status === "already_merged"
          ? "merged"
          : "failed"
    try {
      await this.update(sessionId, task.id, (current) => {
        if (!current.merge) return
        current.merge.status = status
        current.merge.applied_paths = [...new Set([...current.merge.applied_paths, ...transaction.applied_paths])].sort(
          (left, right) => left.localeCompare(right),
        )
        current.merge.conflicts = boundedConflicts
        current.merge.target_fingerprint = transaction.target_fingerprint
        current.merge.completed_at = nowIso(this.now)
        current.merge.error = transaction.error
        current.merge.cleanup = status === "merged" ? "pending" : "not_started"
      })
    } catch (error) {
      result.errors.push(`${task.id}: ${error instanceof Error ? error.message : String(error)}`)
      this.record({ sessionId, taskId: task.id, phase: "settle", outcome: "error" })
      return true
    }

    if (status === "conflict") {
      this.inbox.add({
        session_id: sessionId,
        task_id: task.id,
        run_id: dispatch.run_id,
        kind: "merge_conflict",
        message: `Merge conflict for ${task.id}: ${boundedConflicts.map((conflict) => `${conflict.path} (${conflict.kind}) [${conflict.fingerprint ?? ""}]`).join(", ")}`,
        suggested_actions: [
          "inspect the reported main_path/base_path/child_path",
          "edit the parent file and retry Merge.apply with an explicit resolution",
        ],
      })
      result.continued.push(task.id)
      this.record({ sessionId, taskId: task.id, phase: "reconcile", outcome: "continued" })
      return true
    }
    if (status !== "merged") {
      result.errors.push(`${task.id}: merge recovery returned ${transaction.status}`)
      this.record({ sessionId, taskId: task.id, phase: "settle", outcome: "error" })
      return true
    }
    try {
      await this.cleanupMergeWorkspace(sessionId, task)
      await this.update(sessionId, task.id, (current) => {
        if (current.merge) {
          current.merge.cleanup = "completed"
          current.merge.cleanup_error = undefined
        }
      })
      result.settled.push(task.id)
      this.record({ sessionId, taskId: task.id, phase: "settle", outcome: "settled" })
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error)
      await this.update(sessionId, task.id, (current) => {
        if (current.merge) {
          current.merge.cleanup = "failed"
          current.merge.cleanup_error = reason
        }
      }).catch((updateError) =>
        result.errors.push(`${task.id}: ${updateError instanceof Error ? updateError.message : String(updateError)}`),
      )
      result.errors.push(`${task.id}: cleanup failed: ${reason}`)
      this.inbox.add({
        session_id: sessionId,
        task_id: task.id,
        run_id: dispatch.run_id,
        kind: "merge_cleanup_failed",
        message: `Merge cleanup failed for ${task.id}: ${reason}`,
        suggested_actions: [
          "inspect the exact recorded child/baseline paths",
          "retry cleanup after fixing the workspace service",
        ],
      })
      this.record({ sessionId, taskId: task.id, phase: "settle", outcome: "error" })
    }
    return true
  }

  async reconcilePlan(rootSessionId: string): Promise<RecoveryResult> {
    const result: RecoveryResult = {
      sessionId: rootSessionId,
      continued: [],
      rejected: [],
      settled: [],
      errors: [],
    }
    const plan = this.store.read(taskPath(this.workspaceRoot, rootSessionId))
    if (!plan) return result

    for (const task of plan.steps.flatMap((step) => step.tasks)) {
      if (await this.reconcileMerge(rootSessionId, task, result)) continue
      const dispatch = task.dispatch
      if (!dispatch) continue
      const lifecycle = dispatchLifecycle(dispatch)
      if (task.status === "reported" || task.status === "approved" || task.status === "dismissed") {
        result.settled.push(task.id)
        this.record({ sessionId: rootSessionId, taskId: task.id, phase: "settle", outcome: "settled" })
        continue
      }
      if (!lifecycle || lifecycle === "settled") {
        if (task.status !== "running" && task.status !== "dispatched") {
          result.settled.push(task.id)
          this.record({ sessionId: rootSessionId, taskId: task.id, phase: "settle", outcome: "settled" })
        } else await this.reject(rootSessionId, task, "dispatch has no recoverable lifecycle", result)
        continue
      }
      if (lifecycle === "running") {
        if (await this.isChildActive(dispatch.child_session_id)) {
          result.continued.push(task.id)
          this.record({ sessionId: rootSessionId, taskId: task.id, phase: "reconcile", outcome: "continued" })
        } else {
          await this.reject(rootSessionId, task, "child is no longer active and has not reported", result)
        }
        continue
      }
      const age = this.now() - new Date(dispatch.dispatched_at).getTime()
      if (lifecycle === "starting" && age < this.startingTimeoutMs) {
        result.continued.push(task.id)
        this.record({ sessionId: rootSessionId, taskId: task.id, phase: "reconcile", outcome: "continued" })
        continue
      }
      if (this.resume) {
        try {
          const resumed = await this.resume({ sessionId: rootSessionId, task, dispatch, phase: lifecycle })
          if (resumed.started) {
            await this.update(rootSessionId, task.id, (current) => {
              if (!current.dispatch) return
              if (resumed.childSessionId) current.dispatch.child_session_id = resumed.childSessionId
              current.dispatch.lifecycle = "running"
              current.status = "running"
            })
            result.continued.push(task.id)
            this.record({ sessionId: rootSessionId, taskId: task.id, phase: "resume", outcome: "continued" })
            continue
          }
        } catch (error) {
          result.errors.push(`${task.id}: resume failed: ${error instanceof Error ? error.message : String(error)}`)
        }
      }
      await this.reject(rootSessionId, task, `${lifecycle} lifecycle requires recovery`, result)
    }
    return result
  }
}

const startupReconciles = new Map<string, Promise<RecoveryResult>>()
const activePlanSessions = new Set<string>()

function planSessionKey(workspaceRoot: string, sessionId: string) {
  return `${path.resolve(workspaceRoot)}\0${sessionId}`
}

export function markPlanSessionActive(workspaceRoot: string, sessionId: string) {
  activePlanSessions.add(planSessionKey(workspaceRoot, sessionId))
}

export function hasPlanSessionActivity(workspaceRoot: string, sessionId: string) {
  return activePlanSessions.has(planSessionKey(workspaceRoot, sessionId))
}

export function reconcilePlanOnce(rootSessionId: string, options: RecoveryOptions) {
  const key = planSessionKey(options.workspaceRoot, rootSessionId)
  const existing = startupReconciles.get(key)
  if (existing) return existing
  const pending = new PlanRecovery(options).reconcilePlan(rootSessionId)
  startupReconciles.set(key, pending)
  return pending
}

export function reconcilePlan(rootSessionId: string, options: RecoveryOptions) {
  return new PlanRecovery(options).reconcilePlan(rootSessionId)
}

export async function reconcileAllActivePlans(
  workspaceRoot: string,
  options: Omit<RecoveryOptions, "workspaceRoot"> = {},
) {
  const planRoot = path.join(path.resolve(workspaceRoot), ".jyycode", "plan")
  if (!fs.existsSync(planRoot)) return []
  const sessions = fs
    .readdirSync(planRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && fs.existsSync(path.join(planRoot, entry.name, "plan.json")))
    .map((entry) => entry.name)
  const recovery = new PlanRecovery({ ...options, workspaceRoot })
  const results: RecoveryResult[] = []
  for (const sessionId of sessions) results.push(await recovery.reconcilePlan(sessionId))
  return results
}
