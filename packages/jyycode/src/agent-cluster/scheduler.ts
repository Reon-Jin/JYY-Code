export * as AgentClusterScheduler from "./scheduler"

import { AgentClusterTaskTable } from "./cluster.sql"
import { AgentClusterLifecycle } from "./lifecycle"
import { and, eq, inArray } from "@/storage/db"
import type { RunID, TaskID } from "./schema"
import * as Database from "@/storage/db"
import { Effect } from "effect"
import { ulid } from "ulid"

export type AdmissionResult = {
  admitted: boolean
  reason?: string
  taskRow?: {
    id: TaskID
    plan_task_id: string
    role: string
    model: string
    prompt: string
    title: string
    dependencies: string[]
    child_session_id?: string | null
  }
}

const ACTIVE_RUNNING_STATUSES = ["running", "revising"] as const

export const admitDispatch = Effect.fn("AgentClusterScheduler.admitDispatch")(function* (input: {
  runID: RunID
  planTaskID: string
  maxConcurrency: number
}) {
  return yield* Database.withTransaction((tx) =>
    Effect.gen(function* () {
      const task = yield* tx
        .select()
        .from(AgentClusterTaskTable)
        .where(
          and(
            eq(AgentClusterTaskTable.run_id, input.runID),
            eq(AgentClusterTaskTable.plan_task_id, input.planTaskID),
          ),
        )
        .get()

      if (!task) {
        return { admitted: false, reason: `Task ${input.planTaskID} not found in run ${input.runID}` } as AdmissionResult
      }

      if (task.status !== "queued") {
        return {
          admitted: false,
          reason: `Task ${input.planTaskID} is ${task.status}, not queued`,
        } as AdmissionResult
      }

      // Check dependencies — must all be accepted
      const deps = task.dependencies as string[]
      if (deps.length > 0) {
        const depRows = yield* tx
          .select({ plan_task_id: AgentClusterTaskTable.plan_task_id, status: AgentClusterTaskTable.status })
          .from(AgentClusterTaskTable)
          .where(
            and(
              eq(AgentClusterTaskTable.run_id, input.runID),
              inArray(AgentClusterTaskTable.plan_task_id, deps),
            ),
          )
          .all()

        const statusByID = new Map(depRows.map((r) => [r.plan_task_id, r.status]))
        for (const dep of deps) {
          const depStatus = statusByID.get(dep)
          if (!depStatus) {
            return { admitted: false, reason: `Dependency ${dep} not found in run` } as AdmissionResult
          }
          if (depStatus === "failed" || depStatus === "cancelled") {
            return { admitted: false, reason: `Dependency ${dep} has status ${depStatus}` } as AdmissionResult
          }
          if (depStatus !== "accepted") {
            return { admitted: false, reason: `Dependency ${dep} is ${depStatus}, not yet accepted` } as AdmissionResult
          }
        }
      }

      // Check global concurrency — count currently running + revising tasks
      const allTasks = yield* tx
        .select({ status: AgentClusterTaskTable.status })
        .from(AgentClusterTaskTable)
        .where(eq(AgentClusterTaskTable.run_id, input.runID))
        .all()

      const activeCount = allTasks.filter((t) =>
        (ACTIVE_RUNNING_STATUSES as readonly string[]).includes(t.status),
      ).length

      if (activeCount >= input.maxConcurrency) {
        return {
          admitted: false,
          reason: `Concurrency limit reached: ${activeCount} active, max ${input.maxConcurrency}`,
        } as AdmissionResult
      }

      // Admit: transition queued -> running atomically
      const now = Date.now()
      const result = yield* tx
        .update(AgentClusterTaskTable)
        .set({
          status: "running",
          status_version: task.status_version + 1,
          last_event: "Dispatched by scheduler",
          time_updated: now,
        })
        .where(
          and(
            eq(AgentClusterTaskTable.run_id, input.runID),
            eq(AgentClusterTaskTable.plan_task_id, input.planTaskID),
            eq(AgentClusterTaskTable.status, "queued"),
          ),
        )
        .returning({
          id: AgentClusterTaskTable.id,
          plan_task_id: AgentClusterTaskTable.plan_task_id,
          role: AgentClusterTaskTable.role,
          model: AgentClusterTaskTable.model,
          prompt: AgentClusterTaskTable.prompt,
          title: AgentClusterTaskTable.title,
          dependencies: AgentClusterTaskTable.dependencies,
          child_session_id: AgentClusterTaskTable.child_session_id,
        })
        .get()

      if (!result) {
        return {
          admitted: false,
          reason: `Race: task ${input.planTaskID} was claimed by another dispatcher`,
        } as AdmissionResult
      }

      return {
        admitted: true,
        taskRow: {
          id: result.id as TaskID,
          plan_task_id: result.plan_task_id,
          role: result.role,
          model: result.model,
          prompt: result.prompt,
          title: result.title,
          dependencies: result.dependencies as string[],
          child_session_id: result.child_session_id,
        },
      } as AdmissionResult
    }),
  )
})
