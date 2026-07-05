import { describe, expect, test } from "bun:test"
import { AgentClusterScheduler } from "../../src/agent-cluster/scheduler"
import { AgentCluster } from "../../src/agent-cluster/cluster"
import { AgentClusterRunTable, AgentClusterTaskTable } from "../../src/agent-cluster/cluster.sql"
import type { Plan, RunID } from "../../src/agent-cluster/schema"
import { AgentClusterRuntime } from "../../src/agent-cluster/runtime"
import * as Database from "../../src/storage/db"
import { Session } from "../../src/session/session"
import { MessageID } from "../../src/session/schema"
import { ModelID, ProviderID } from "../../src/provider/schema"
import { Effect } from "effect"
import { testEffect } from "../lib/effect"

const it = testEffect(Session.defaultLayer)

describe("AgentCluster scheduler", () => {
  it.instance("admitDispatch transitions queued -> running and rejects non-queued tasks", () =>
    Effect.gen(function* () {
      const sessions = yield* Session.Service
      const chat = yield* sessions.create({ title: "Cluster run" })
      const user = yield* sessions.updateMessage({
        id: MessageID.ascending(),
        role: "user",
        sessionID: chat.id,
        agent: "cluster",
        model: { providerID: ProviderID.make("test"), modelID: ModelID.make("test") },
        time: { created: Date.now() },
      })
      const runID = AgentCluster.createRunID() as RunID
      const now = Date.now()
      Database.use((db) => {
        db.insert(AgentClusterRunTable).values({
          id: runID, session_id: chat.id, parent_message_id: user.id,
          enabled: true, status: "planning", goal: "test",
          planner_model: "test/p", reviewer_model: "test/r",
          status_version: 0, time_created: now, time_updated: now,
        }).run()
        db.insert(AgentClusterTaskTable).values({
          id: AgentClusterRuntime.coerceTaskID("task-a"), run_id: runID,
          plan_task_id: "task-a", step: 1, dependencies: [],
          role: "researcher", title: "A", prompt: "Do A", complexity: "simple",
          model: "test/m", status: "queued", status_version: 0,
          acceptance_criteria: ["done"], artifact_paths: [], time_created: now, time_updated: now,
        }).run()
        db.insert(AgentClusterTaskTable).values({
          id: AgentClusterRuntime.coerceTaskID("task-b"), run_id: runID,
          plan_task_id: "task-b", step: 1, dependencies: [],
          role: "writer", title: "B", prompt: "Do B", complexity: "simple",
          model: "test/m", status: "running", status_version: 1,
          acceptance_criteria: ["done"], artifact_paths: [], time_created: now, time_updated: now,
        }).run()
      })

      // Admission succeeds for queued task
      const result = yield* AgentClusterScheduler.admitDispatch({
        runID, planTaskID: "task-a", maxConcurrency: 5,
      })
      expect(result.admitted).toBe(true)
      expect(result.taskRow?.plan_task_id).toBe("task-a")

      // Verify status changed to running
      const row = Database.use((db) =>
        db.select().from(AgentClusterTaskTable)
          .where(Database.and(
            Database.eq(AgentClusterTaskTable.run_id, runID),
            Database.eq(AgentClusterTaskTable.plan_task_id, "task-a"),
          )).get(),
      )
      expect(row?.status).toBe("running")

      // Second admission fails — already running
      const again = yield* AgentClusterScheduler.admitDispatch({
        runID, planTaskID: "task-a", maxConcurrency: 5,
      })
      expect(again.admitted).toBe(false)
      expect(again.reason).toContain("running")

      // Unknown task fails
      const unknown = yield* AgentClusterScheduler.admitDispatch({
        runID, planTaskID: "nonexistent", maxConcurrency: 5,
      })
      expect(unknown.admitted).toBe(false)
    }),
  )

  it.instance("blocks dispatch when dependencies are not accepted", () =>
    Effect.gen(function* () {
      const sessions = yield* Session.Service
      const chat = yield* sessions.create({ title: "Cluster run" })
      const user = yield* sessions.updateMessage({
        id: MessageID.ascending(),
        role: "user", sessionID: chat.id, agent: "cluster",
        model: { providerID: ProviderID.make("test"), modelID: ModelID.make("test") },
        time: { created: Date.now() },
      })
      const runID = AgentCluster.createRunID() as RunID
      const now = Date.now()
      Database.use((db) => {
        db.insert(AgentClusterRunTable).values({
          id: runID, session_id: chat.id, parent_message_id: user.id,
          enabled: true, status: "planning", goal: "test",
          planner_model: "test/p", reviewer_model: "test/r",
          status_version: 0, time_created: now, time_updated: now,
        }).run()
        // Dependency: running (not accepted)
        db.insert(AgentClusterTaskTable).values({
          id: AgentClusterRuntime.coerceTaskID("dep"), run_id: runID,
          plan_task_id: "dep", step: 1, dependencies: [],
          role: "researcher", title: "Dep", prompt: "Do dep", complexity: "simple",
          model: "test/m", status: "running", status_version: 1,
          acceptance_criteria: ["done"], artifact_paths: [], time_created: now, time_updated: now,
        }).run()
        // Dependent: queued with dependency on "dep"
        db.insert(AgentClusterTaskTable).values({
          id: AgentClusterRuntime.coerceTaskID("child"), run_id: runID,
          plan_task_id: "child", step: 2, dependencies: ["dep"],
          role: "writer", title: "Child", prompt: "Do child", complexity: "simple",
          model: "test/m", status: "queued", status_version: 0,
          acceptance_criteria: ["done"], artifact_paths: [], time_created: now, time_updated: now,
        }).run()
      })

      const result = yield* AgentClusterScheduler.admitDispatch({
        runID, planTaskID: "child", maxConcurrency: 5,
      })
      expect(result.admitted).toBe(false)
      expect(result.reason).toContain("not yet accepted")
    }),
  )

  it.instance("blocks dispatch when concurrency limit is reached", () =>
    Effect.gen(function* () {
      const sessions = yield* Session.Service
      const chat = yield* sessions.create({ title: "Cluster run" })
      const user = yield* sessions.updateMessage({
        id: MessageID.ascending(),
        role: "user", sessionID: chat.id, agent: "cluster",
        model: { providerID: ProviderID.make("test"), modelID: ModelID.make("test") },
        time: { created: Date.now() },
      })
      const runID = AgentCluster.createRunID() as RunID
      const now = Date.now()
      Database.use((db) => {
        db.insert(AgentClusterRunTable).values({
          id: runID, session_id: chat.id, parent_message_id: user.id,
          enabled: true, status: "dispatching", goal: "test",
          planner_model: "test/p", reviewer_model: "test/r",
          status_version: 0, time_created: now, time_updated: now,
        }).run()
        // Two running tasks
        for (let i = 1; i <= 2; i++) {
          db.insert(AgentClusterTaskTable).values({
            id: AgentClusterRuntime.coerceTaskID(`running-${i}`), run_id: runID,
            plan_task_id: `running-${i}`, step: 1, dependencies: [],
            role: "researcher", title: `R${i}`, prompt: "Do", complexity: "simple",
            model: "test/m", status: "running", status_version: 1,
            acceptance_criteria: ["done"], artifact_paths: [], time_created: now, time_updated: now,
          }).run()
        }
        // One queued task
        db.insert(AgentClusterTaskTable).values({
          id: AgentClusterRuntime.coerceTaskID("queued-1"), run_id: runID,
          plan_task_id: "queued-1", step: 1, dependencies: [],
          role: "writer", title: "Q1", prompt: "Do", complexity: "simple",
          model: "test/m", status: "queued", status_version: 0,
          acceptance_criteria: ["done"], artifact_paths: [], time_created: now, time_updated: now,
        }).run()
      })

      const result = yield* AgentClusterScheduler.admitDispatch({
        runID, planTaskID: "queued-1", maxConcurrency: 2,
      })
      expect(result.admitted).toBe(false)
      expect(result.reason).toContain("Concurrency limit")
      expect(result.reason).toContain("2 active")
    }),
  )
})
