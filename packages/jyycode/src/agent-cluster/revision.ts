export * as AgentClusterRevision from "./revision"

import { AgentClusterTaskTable } from "./cluster.sql"
import { AgentClusterLifecycle } from "./lifecycle"
import type { RunID, TaskID } from "./schema"
import * as Database from "@/storage/db"
import { and, eq } from "@/storage/db"
import { Effect } from "effect"

export const requestRevision = Effect.fn("AgentClusterRevision.requestRevision")(function* (input: {
  runID: RunID
  taskID: TaskID
  revisionPrompt: string
  maxReviewRounds: number
}) {
  return yield* Database.withTransaction((tx) =>
    Effect.gen(function* () {
      const task = yield* tx
        .select()
        .from(AgentClusterTaskTable)
        .where(
          and(
            eq(AgentClusterTaskTable.run_id, input.runID),
            eq(AgentClusterTaskTable.id, input.taskID),
          ),
        )
        .get()

      if (!task) {
        return yield* Effect.fail(
          new Error(`Task ${input.taskID} not found in run ${input.runID}`),
        )
      }

      if (task.status !== "revision_requested") {
        return yield* Effect.fail(
          new Error(`Task ${input.taskID} is ${task.status}, not revision_requested`),
        )
      }

      // Enforce round limit
      if (task.review_round >= input.maxReviewRounds) {
        const now = Date.now()
        yield* tx
          .update(AgentClusterTaskTable)
          .set({
            status: "failed",
            status_version: task.status_version + 1,
            last_event: `Revision limit exceeded (round ${task.review_round} >= ${input.maxReviewRounds})`,
            time_updated: now,
          })
          .where(
            and(
              eq(AgentClusterTaskTable.run_id, input.runID),
              eq(AgentClusterTaskTable.id, input.taskID),
            ),
          )
          .run()
        return yield* Effect.fail(
          new Error(`Revision limit exceeded: round ${task.review_round} >= ${input.maxReviewRounds}`),
        )
      }

      // Transition to revising
      const now = Date.now()
      yield* tx
        .update(AgentClusterTaskTable)
        .set({
          status: "revising",
          status_version: task.status_version + 1,
          revision_prompt: input.revisionPrompt,
          last_event: "Revision started",
          time_updated: now,
        })
        .where(
          and(
            eq(AgentClusterTaskTable.run_id, input.runID),
            eq(AgentClusterTaskTable.id, input.taskID),
            eq(AgentClusterTaskTable.status, "revision_requested"),
          ),
        )
        .run()

      return {
        childSessionID: task.child_session_id,
        revisionPrompt: input.revisionPrompt,
        round: task.review_round,
      }
    }),
  )
})

export function buildRevisionPrompt(originalPrompt: string, revisionPrompt: string, reviewIssues: readonly string[]): string {
  return [
    "<revision-request>",
    "Your previous submission needs revision based on the reviewer's feedback.",
    "",
    "## Review Issues",
    ...reviewIssues.map((issue, i) => `${i + 1}. ${issue}`),
    "",
    "## Revision Instructions",
    revisionPrompt,
    "",
    "## Original Task",
    originalPrompt,
    "</revision-request>",
  ].join("\n")
}
