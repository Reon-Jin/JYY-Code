import fs from "node:fs"
import path from "node:path"
import { clonePlan, planFilePath, type DispatchRecord, type PlanFile, type PlanTask } from "./schema"
import { PlanStore, defaultPlanStore } from "./store"
import { PlanInbox, defaultPlanInbox } from "./events"
import { childTerminationRequest, type ChildController } from "./protocol"
import { ChildWorkspace } from "./child-workspace"
import {
  cleanupRecordFromLegacy,
  legacyCleanupStatus,
  WorkspaceCleanupService,
  type CleanupRecord,
} from "./workspace-cleanup"
import {
  applyWorkspaceMerge,
  removeMergeJournal,
  workspaceFingerprint,
  type WorkspaceMergeTransactionResult,
} from "./workspace-merge"
import { activationOwnerId, defaultPlanActivationStore, PlanActivationStore } from "./activation"

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
  phase: "reserved" | "child_created" | "starting" | "running"
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
  workspaceCleanup?: WorkspaceCleanupService
  activation?: PlanActivationStore
  ownerId?: string
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
  private readonly workspaceCleanup: WorkspaceCleanupService
  private readonly activation: PlanActivationStore
  private readonly ownerId: string

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
    this.workspaceCleanup = options.workspaceCleanup ?? new WorkspaceCleanupService()
    this.activation = options.activation ?? defaultPlanActivationStore
    this.ownerId = options.ownerId ?? activationOwnerId()
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

  private async settleActivation(task: PlanTask, childSessionId = task.dispatch?.child_session_id) {
    const generation = task.dispatch?.activation_generation
    if (!generation || !childSessionId) return
    return this.activation.settle({
      session_id: childSessionId,
      owner_id: this.ownerId,
      generation,
      now: this.now(),
    })
  }

  private workspaceRemovalGuard(childSessionId?: string) {
    if (!childSessionId) return undefined
    return {
      reason: "child activation has not settled; preserve workspace for recovery",
      canRemove: () => {
        const activation = this.activation.get(childSessionId)
        return !activation || activation.state === "settled"
      },
    }
  }

  private async cleanupRejectedWorkspace(sessionId: string, task: PlanTask) {
    const workspace = task.dispatch?.workspace
    if (!workspace) {
      if (!task.dispatch?.child_session_id) return undefined
      if (!this.children) throw new Error("child termination coordinator unavailable")
      const result = await this.children.terminate(task.dispatch.child_session_id)
      if (result?.state !== "stop_failed") await this.settleActivation(task)
      return result?.state === "stop_failed" ? `${result.phase}: ${result.message}` : undefined
    }
    const result = await this.workspaceCleanup.run({
      rootSessionId: sessionId,
      taskId: task.id,
      workspaceDirectory: workspace.directory,
      record:
        task.merge?.cleanup_record ??
        cleanupRecordFromLegacy(task.merge?.cleanup, task.merge?.cleanup_error, this.now),
      now: this.now,
      deleteWorkspace: workspace.mode !== "shared_compat",
      stop: async () => {
        if (!task.dispatch?.child_session_id || !this.children) return
        const result = await this.children.terminate(
          task.dispatch.child_session_id,
          childTerminationRequest(workspace),
        )
        if (result?.state !== "stop_failed") await this.settleActivation(task)
        return result
      },
      remove: async () => {
        if (!this.childWorkspace) throw new Error("child workspace manager unavailable")
        const reservation = this.childWorkspace.reserve(sessionId, task.id)
        const loaded = this.childWorkspace.load({ ...reservation, ...workspace, name: reservation.name })
        if (!loaded) {
          const paths = [workspace.directory, workspace.baseline_directory, workspace.baseline_manifest_path]
            .filter((value): value is string => Boolean(value))
            .map((value) => path.resolve(value))
          if (paths.every((value) => !fs.existsSync(value))) return true
          throw new Error("recorded child workspace could not be reconstructed")
        }
        await this.childWorkspace.remove(loaded.directory, this.workspaceRemovalGuard(task.dispatch?.child_session_id))
        return true
      },
      persist: (record) => this.persistCleanupRecord(sessionId, task.id, record),
    })
    return result.record.state === "failed" || result.record.state === "quarantined"
      ? result.record.last_error?.message ?? result.record.state
      : undefined
  }

  private async reject(sessionId: string, task: PlanTask, reason: string, result: RecoveryResult) {
    const cleanupErrors: string[] = []
    try {
      const error = await this.cleanupRejectedWorkspace(sessionId, task)
      if (error) cleanupErrors.push(`workspace cleanup: ${error}`)
    } catch (error) {
      cleanupErrors.push(`child cleanup: ${error instanceof Error ? error.message : String(error)}`)
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

  private async persistCleanupRecord(sessionId: string, taskId: string, record: CleanupRecord) {
    await this.update(sessionId, taskId, (current) => {
      if (!current.merge) return
      current.merge.cleanup_record = structuredClone(record)
      current.merge.cleanup = legacyCleanupStatus(record)
      if (record.last_error) current.merge.cleanup_error = record.last_error.message
      else if (record.state === "completed") current.merge.cleanup_error = undefined
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
    const canonicalChild = fs.existsSync(childDirectory) ? fs.realpathSync.native(childDirectory) : childDirectory
    const canonicalBaseline = fs.existsSync(baselineDirectory)
      ? fs.realpathSync.native(baselineDirectory)
      : baselineDirectory
    if (
      !pathWithin(runtimeRoot, canonicalChild) ||
      !pathWithin(runtimeRoot, canonicalBaseline) ||
      canonicalChild === canonicalBaseline
    )
      throw new Error("recorded merge workspace resolves outside the owning runtime root")
    // A reported/approved task has no useful work left in the child loop. If
    // recovery starts without a child controller, settle the durable
    // activation before allowing merge cleanup to remove its workspace.
    if (!(await this.isChildActive(task.dispatch?.child_session_id ?? ""))) await this.settleActivation(task)
    const reservation = this.childWorkspace.reserve(sessionId, task.id)
    const result = await this.workspaceCleanup.run({
      rootSessionId: sessionId,
      taskId: task.id,
      workspaceDirectory: canonicalChild,
      record:
        task.merge?.cleanup_record ??
        cleanupRecordFromLegacy(task.merge?.cleanup, task.merge?.cleanup_error, this.now),
      now: this.now,
      stop: async () => {
        if (!this.children) return
        if (!task.dispatch?.child_session_id) return
        const result = await this.children.terminate(
          task.dispatch.child_session_id,
          childTerminationRequest(workspace),
        )
        if (result?.state !== "stop_failed") await this.settleActivation(task)
        return result
      },
      remove: async () => {
        const loaded = this.childWorkspace?.load({
          ...reservation,
          ...workspace,
          rootSessionId: sessionId,
          taskId: task.id,
          name: reservation.name,
          directory: canonicalChild,
          baseline_directory: canonicalBaseline,
        })
        if (!loaded) {
          const paths = [childDirectory, baselineDirectory, workspace.baseline_manifest_path]
            .filter((value): value is string => Boolean(value))
            .map((value) => path.resolve(value))
          if (paths.every((value) => !fs.existsSync(value))) return true
          throw new Error("recorded child workspace could not be reconstructed")
        }
        await this.childWorkspace!.remove(loaded.directory, this.workspaceRemovalGuard(task.dispatch?.child_session_id))
        if (task.merge?.journal_directory) removeMergeJournal(task.merge.journal_directory, runtimeRoot)
        return true
      },
      persist: (record) => this.persistCleanupRecord(sessionId, task.id, record),
    })
    if (result.record.state === "failed" || result.record.state === "quarantined")
      throw new Error(`${result.record.last_error?.phase ?? "cleanup"}: ${result.record.last_error?.message ?? result.record.state}`)
    return result
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
        const activation = this.activation.get(dispatch.child_session_id)
        if (activation) {
          if (activation.state === "settled") {
            await this.reject(rootSessionId, task, "durable child activation is already settled", result)
            continue
          }
          if (activation.lease_expires_at > this.now()) {
            // A durable live lease is evidence that another process may still
            // own the child. Do not start a second loop during cold start.
            result.continued.push(task.id)
            this.record({ sessionId: rootSessionId, taskId: task.id, phase: "reconcile", outcome: "continued" })
            continue
          }
          try {
            const takeover = this.activation.takeover({
              session_id: dispatch.child_session_id,
              owner_id: this.ownerId,
              now: this.now(),
              reason: "owner_lease_expired",
            })
            await this.update(rootSessionId, task.id, (current) => {
              if (!current.dispatch) return
              current.dispatch.activation_generation = takeover.generation
              current.dispatch.lifecycle = "starting"
            })
            const active = await this.isChildActive(dispatch.child_session_id)
            if (active) {
              this.activation.transition({
                session_id: takeover.session_id,
                owner_id: this.ownerId,
                generation: takeover.generation,
                state: "running",
                now: this.now(),
              })
              result.continued.push(task.id)
              this.record({ sessionId: rootSessionId, taskId: task.id, phase: "reconcile", outcome: "continued" })
              continue
            }
            if (this.resume) {
              const resumed = await this.resume({ sessionId: rootSessionId, task, dispatch, phase: "running" })
              if (resumed.started) {
                this.activation.transition({
                  session_id: takeover.session_id,
                  owner_id: this.ownerId,
                  generation: takeover.generation,
                  state: "running",
                  now: this.now(),
                })
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
            }
          } catch (error) {
            result.errors.push(`${task.id}: activation takeover failed: ${error instanceof Error ? error.message : String(error)}`)
          }
          await this.reject(rootSessionId, task, "child owner lease expired and the child is no longer active", result)
          continue
        }
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
