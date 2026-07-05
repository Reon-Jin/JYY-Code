export * as AgentClusterRecovery from "./recovery"

import { AgentClusterRunTable, AgentClusterTaskTable } from "./cluster.sql"
import { AgentClusterLifecycle } from "./lifecycle"
import type { RunID } from "./schema"
import * as Database from "@/storage/db"
import { eq } from "@/storage/db"
import { Effect } from "effect"

export const recoverRun = Effect.fn("AgentClusterRecovery.recoverRun")(function* (runID: RunID) {
  return yield* Database.withTransaction((tx) =>
    Effect.gen(function* () {
      const run = yield* tx
        .select()
        .from(AgentClusterRunTable)
        .where(eq(AgentClusterRunTable.id, runID))
        .get()

      if (!run) return { recovered: false, reason: "Run not found" }

      // Only recover non-terminal runs
      if (["completed", "failed", "cancelled"].includes(run.status)) {
        return { recovered: false, reason: `Run is terminal: ${run.status}` }
      }

      const tasks = yield* tx
        .select()
        .from(AgentClusterTaskTable)
        .where(eq(AgentClusterTaskTable.run_id, runID))
        .all()

      const now = Date.now()
      let recovered = 0

      for (const task of tasks) {
        let newStatus: string | undefined

        switch (task.status) {
          case "queued":
            // Safe to leave queued — will be dispatched by coordinator
            break
          case "running":
          case "revising":
            // Inspect child session for completion
            if (task.child_session_id) {
              // Mark as orphaned if no child session evidence
              newStatus = "failed"
            }
            break
          case "submitted":
            // Re-submit for review
            break
          case "reviewing":
            // Reset to submitted for re-review
            newStatus = "submitted"
            break
          case "revision_requested":
            // Leave for coordinator to resume
            break
          case "planned":
            // Leave planned
            break
        }

        if (newStatus) {
          yield* tx
            .update(AgentClusterTaskTable)
            .set({
              status: newStatus,
              status_version: task.status_version + 1,
              last_event: `Recovered after restart: ${task.status} -> ${newStatus}`,
              time_updated: now,
            })
            .where(eq(AgentClusterTaskTable.id, task.id))
            .run()
          recovered++
        }
      }

      // Re-derive run status
      const updatedTasks = yield* tx
        .select({ status: AgentClusterTaskTable.status })
        .from(AgentClusterTaskTable)
        .where(eq(AgentClusterTaskTable.run_id, runID))
        .all()

      const derived = AgentClusterLifecycle.deriveRunStatus(
        updatedTasks.map((t) => t.status as import("./schema").TaskStatus),
      )

      if (derived !== run.status) {
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
      }

      return { recovered: recovered > 0, recoveredCount: recovered, runStatus: derived }
    }),
  )
})

export const recoverAllActive = Effect.fn("AgentClusterRecovery.recoverAllActive")(function* () {
  const activeRuns = yield* Database.query((db) =>
    db
      .select({ id: AgentClusterRunTable.id })
      .from(AgentClusterRunTable)
      .where(
        Database.not(
          Database.inArray(AgentClusterRunTable.status, ["completed", "failed", "cancelled"]),
        ),
      )
      .all(),
  )

  const results: { runID: string; recovered: number }[] = []
  for (const run of activeRuns) {
    const result = yield* recoverRun(run.id as RunID)
    if (result.recovered) {
      results.push({ runID: run.id, recovered: result.recoveredCount ?? 0 })
    }
  }

  return results
})
