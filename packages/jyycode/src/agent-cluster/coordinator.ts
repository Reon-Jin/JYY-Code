export * as AgentClusterCoordinator from "./coordinator"

import { AgentClusterRunTable, AgentClusterTaskTable } from "./cluster.sql"
import { AgentClusterLifecycle } from "./lifecycle"
import type { RunID, RunStatus } from "./schema"
import * as Database from "@/storage/db"
import { and, eq } from "@/storage/db"
import { Effect } from "effect"

export const reconcileRun = Effect.fn("AgentClusterCoordinator.reconcileRun")(function* (runID: RunID) {
  return yield* Database.withTransaction((tx) =>
    Effect.gen(function* () {
      const run = yield* tx
        .select()
        .from(AgentClusterRunTable)
        .where(eq(AgentClusterRunTable.id, runID))
        .get()

      if (!run) return { action: "noop" as const, reason: "Run not found" }

      // Only reconcile active runs
      if (["completed", "failed", "cancelled"].includes(run.status)) {
        return { action: "noop" as const, reason: `Run is terminal: ${run.status}` }
      }

      const tasks = yield* tx
        .select()
        .from(AgentClusterTaskTable)
        .where(eq(AgentClusterTaskTable.run_id, runID))
        .all()

      const statuses = tasks.map((t) => t.status as import("./schema").TaskStatus)
      const derived = AgentClusterLifecycle.deriveRunStatus(statuses)

      if (derived !== run.status) {
        const now = Date.now()
        yield* tx
          .update(AgentClusterRunTable)
          .set({
            status: derived,
            status_version: run.status_version + 1,
            time_updated: now,
            ...(derived === "completed" || derived === "failed" ? { completed_at: now } : {}),
          })
          .where(eq(AgentClusterRunTable.id, runID))
          .run()

        return {
          action: "transitioned" as const,
          from: run.status,
          to: derived,
          taskCount: tasks.length,
        }
      }

      return {
        action: "noop" as const,
        reason: `Run already ${run.status}, ${tasks.length} tasks`,
      }
    }),
  )
})

export const getReadyTasks = Effect.fn("AgentClusterCoordinator.getReadyTasks")(function* (runID: RunID) {
  return yield* Database.query((db) =>
    db
      .select()
      .from(AgentClusterTaskTable)
      .where(
        and(
          eq(AgentClusterTaskTable.run_id, runID),
          eq(AgentClusterTaskTable.status, "queued"),
        ),
      )
      .all(),
  )
})

export const getSubmittedTasks = Effect.fn("AgentClusterCoordinator.getSubmittedTasks")(function* (runID: RunID) {
  return yield* Database.query((db) =>
    db
      .select()
      .from(AgentClusterTaskTable)
      .where(
        and(
          eq(AgentClusterTaskTable.run_id, runID),
          eq(AgentClusterTaskTable.status, "submitted"),
        ),
      )
      .all(),
  )
})

export const getRevisionRequestedTasks = Effect.fn("AgentClusterCoordinator.getRevisionRequestedTasks")(
  function* (runID: RunID) {
    return yield* Database.query((db) =>
      db
        .select()
        .from(AgentClusterTaskTable)
        .where(
          and(
            eq(AgentClusterTaskTable.run_id, runID),
            eq(AgentClusterTaskTable.status, "revision_requested"),
          ),
        )
        .all(),
    )
  },
)

export const getActiveCount = Effect.fn("AgentClusterCoordinator.getActiveCount")(function* (runID: RunID) {
  const tasks = yield* Database.query((db) =>
    db
      .select({ id: AgentClusterTaskTable.id, status: AgentClusterTaskTable.status })
      .from(AgentClusterTaskTable)
      .where(eq(AgentClusterTaskTable.run_id, runID))
      .all(),
  )

  return tasks.filter((t) => ["running", "revising"].includes(t.status)).length
})
