import fs from "node:fs"
import path from "node:path"
import {
  clonePlan,
  planFilePath,
  type DispatchRecord,
  type PlanFile,
  type PlanTask,
  type TaskStatus,
} from "./schema"
import { PlanStore, defaultPlanStore } from "./store"
import { PlanInbox, defaultPlanInbox } from "./events"
import type { ChildController } from "./protocol"
import { ChildWorkspace } from "./child-workspace"

export type RecoveryResult = {
  sessionId: string
  continued: string[]
  rejected: string[]
  settled: string[]
  errors: string[]
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
  }

  private async update(
    sessionId: string,
    taskId: string,
    apply: (task: PlanTask, plan: PlanFile) => void,
  ) {
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
    try {
      if (childSessionId && this.children) await this.children.terminate(childSessionId)
    } catch (error) {
      cleanupErrors.push(`child cleanup: ${error instanceof Error ? error.message : String(error)}`)
    }
    try {
      if (workspaceDirectory && this.childWorkspace) await this.childWorkspace.remove(workspaceDirectory)
    } catch (error) {
      cleanupErrors.push(`workspace cleanup: ${error instanceof Error ? error.message : String(error)}`)
    }
    try {
      await this.update(sessionId, task.id, (current) => {
        current.status = "rejected"
        if (current.dispatch) current.dispatch.lifecycle = "settled"
      })
      result.rejected.push(task.id)
    } catch (error) {
      result.errors.push(`${task.id}: ${error instanceof Error ? error.message : String(error)}`)
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
      const dispatch = task.dispatch
      if (!dispatch) continue
      const lifecycle = dispatchLifecycle(dispatch)
      if (task.status === "reported" || task.status === "approved" || task.status === "dismissed") {
        result.settled.push(task.id)
        continue
      }
      if (!lifecycle || lifecycle === "settled") {
        if (task.status !== "running" && task.status !== "dispatched") result.settled.push(task.id)
        else await this.reject(rootSessionId, task, "dispatch has no recoverable lifecycle", result)
        continue
      }
      if (lifecycle === "running") {
        if (await this.isChildActive(dispatch.child_session_id)) {
          result.continued.push(task.id)
        } else {
          await this.reject(rootSessionId, task, "child is no longer active and has not reported", result)
        }
        continue
      }
      const age = Date.now() - new Date(dispatch.dispatched_at).getTime()
      if (lifecycle === "starting" && age < this.startingTimeoutMs) {
        result.continued.push(task.id)
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

export function reconcilePlan(rootSessionId: string, options: RecoveryOptions) {
  return new PlanRecovery(options).reconcilePlan(rootSessionId)
}

export async function reconcileAllActivePlans(workspaceRoot: string, options: Omit<RecoveryOptions, "workspaceRoot"> = {}) {
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
