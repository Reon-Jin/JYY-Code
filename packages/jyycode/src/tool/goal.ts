import { Effect, Schema } from "effect"
import * as Tool from "./tool"
import { Session } from "@/session/session"

export const GoalDoneParameters = Schema.Struct({
  summary: Schema.String.annotate({
    description: "A concise summary of what was completed or why the goal cannot be reached.",
  }),
  status: Schema.optional(Schema.Literals(["done", "failed"])).annotate({
    description: "Defaults to done. Use failed when the goal is impossible or blocked.",
  }),
  reason: Schema.optional(Schema.String).annotate({
    description: "Required context when status=failed.",
  }),
})

type Metadata = { status: "done" | "failed" | "unchanged" }

export const GoalTool = Tool.define<typeof GoalDoneParameters, Metadata, Session.Service>(
  "Goal_done",
  Effect.gen(function* () {
    const sessions = yield* Session.Service

    return {
      description:
        "Mark the active goal as complete or failed. Call this only when the goal condition is fully satisfied, or when the goal is impossible/blocked and you must stop. Do not call it merely because a turn ended.",
      parameters: GoalDoneParameters,
      catalog: {
        category: "other",
        mutability: "write",
        risk: "low",
        detail: "advanced",
      },
      execute: (params, ctx) =>
        Effect.gen(function* () {
          const session = yield* sessions.get(ctx.sessionID)
          const goal = session.goal
          if (!goal || goal.status !== "running") {
            return {
              title: "Goal not running",
              metadata: { status: "unchanged" as const },
              output: "No active goal is running, so no goal state was changed.",
            }
          }
          const status = params.status ?? "done"
          yield* sessions.setGoal({
            sessionID: ctx.sessionID,
            goal: {
              ...goal,
              status,
              result: params.reason ?? params.summary,
            },
          })
          return {
            title: `Goal ${status}`,
            metadata: { status },
            output: `Goal marked ${status}. Summary: ${params.summary}`,
          }
        }).pipe(Effect.orDie),
    }
  }),
)

export * as Goal from "./goal"
