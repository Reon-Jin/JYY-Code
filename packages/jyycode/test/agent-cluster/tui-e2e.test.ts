// @ts-nocheck -- runtime assertions cover branded API boundaries directly.
import { describe, expect } from "bun:test"
import { Effect } from "effect"
import { AgentCluster } from "@/agent-cluster/cluster"
import { Session } from "@/session/session"
import { testEffect } from "../lib/effect"

const it = testEffect(Session.defaultLayer)

describe("agent cluster session graph E2E", () => {
  it.instance("returns one task graph without a run layer", () =>
    Effect.gen(function* () {
      const session = yield* (yield* Session.Service).create({ title: "TUI graph" })
      yield* AgentCluster.persistPlan({
        sessionID: session.id,
        plan: {
          goal: "Build report",
          tasks: [
            {
              id: "research" as any,
              step: 1,
              title: "Research",
              role: "researcher",
              complexity: "simple",
              model: "test/simple",
              dependencies: [],
              prompt: "Research",
              acceptanceCriteria: [],
              expectedArtifacts: [],
            },
            {
              id: "write" as any,
              step: 2,
              title: "Write",
              role: "writer",
              complexity: "complex",
              model: "test/complex",
              dependencies: ["research" as any],
              prompt: "Write",
              acceptanceCriteria: [],
              expectedArtifacts: [],
            },
          ],
        },
      })
      yield* AgentCluster.markTaskRunning({
        sessionID: session.id,
        taskID: "research",
        childSessionID: "ses_research" as any,
      })
      const state = yield* AgentCluster.getSessionState(session.id)
      expect(state).not.toHaveProperty("runs")
      expect(state.tasks.map((task) => [task.id, task.status, task.step])).toEqual([
        ["research", "running", 1],
        ["write", "planned", 2],
      ])
    }),
  )
})
