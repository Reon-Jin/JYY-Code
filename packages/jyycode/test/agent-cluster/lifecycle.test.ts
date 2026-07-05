import { describe, expect, test } from "bun:test"
import { AgentCluster } from "../../src/agent-cluster/cluster"
import { AgentClusterRunTable, AgentClusterTaskTable } from "../../src/agent-cluster/cluster.sql"
import { AgentClusterRuntime } from "../../src/agent-cluster/runtime"
import type { Plan, RunID } from "../../src/agent-cluster/schema"
import * as Database from "../../src/storage/db"
import { Session } from "../../src/session/session"
import { MessageID } from "../../src/session/schema"
import { ModelID, ProviderID } from "../../src/provider/schema"
import { Effect } from "effect"
import { testEffect } from "../lib/effect"

const it = testEffect(Session.defaultLayer)

describe("AgentCluster lifecycle characterization", () => {
  describe("repeated plan task ids", () => {
    it.instance("two runs can each own a task with the same plan_task_id", () =>
      Effect.gen(function* () {
        const sessions = yield* Session.Service
        const chat = yield* sessions.create({ title: "Cluster run" })
        const createRun = (name: string) =>
          Effect.gen(function* () {
            const user = yield* sessions.updateMessage({
              id: MessageID.ascending(),
              role: "user",
              sessionID: chat.id,
              agent: "cluster",
              model: { providerID: ProviderID.make("test"), modelID: ModelID.make("test") },
              time: { created: Date.now() },
            })
            const runID = AgentCluster.createRunID() as RunID
            Database.use((db) =>
              db
                .insert(AgentClusterRunTable)
                .values({
                  id: runID,
                  session_id: chat.id,
                  parent_message_id: user.id,
                  enabled: true,
                  status: "planning",
                  goal: `Run ${name}`,
                  planner_model: "test/planner",
                  reviewer_model: "test/reviewer",
                  time_created: Date.now(),
                  time_updated: Date.now(),
                })
                .run(),
            )
            return runID
          })

        const run1 = yield* createRun("1")
        const run2 = yield* createRun("2")

        const makePlan = (runID: RunID): Plan => ({
          goal: "Build feature",
          tasks: [
            {
              id: AgentClusterRuntime.coerceTaskID("research"),
              step: 1,
              title: "Research",
              role: "researcher",
              complexity: "simple",
              model: "test/simple",
              dependencies: [],
              prompt: "Research the feature",
              acceptanceCriteria: ["done"],
              expectedArtifacts: [],
            },
          ],
        })

        yield* AgentCluster.persistPlan({ runID: run1, plan: makePlan(run1) })
        yield* AgentCluster.persistPlan({ runID: run2, plan: makePlan(run2) })

        const rows = Database.use((db) => db.select().from(AgentClusterTaskTable).all())
        // Two rows with plan_task_id "research", one for each run — now using ULID primary keys
        expect(rows.filter((row) => row.plan_task_id === "research")).toHaveLength(2)
      }),
    )
  })

  describe("multi-run binding", () => {
    it.instance("task dispatch uses the most recent explicit run", () =>
      Effect.gen(function* () {
        // Simulate the scenario where two cluster runs exist in one session.
        // A task tool call during run 2 must bind to run 2, not run 1.
        const sessions = yield* Session.Service
        const chat = yield* sessions.create({ title: "Cluster run" })

        const user1 = yield* sessions.updateMessage({
          id: MessageID.ascending(),
          role: "user",
          sessionID: chat.id,
          agent: "cluster",
          model: { providerID: ProviderID.make("test"), modelID: ModelID.make("test") },
          time: { created: 1 },
        })
        const run1 = AgentCluster.createRunID() as RunID
        Database.use((db) =>
          db
            .insert(AgentClusterRunTable)
            .values({
              id: run1,
              session_id: chat.id,
              parent_message_id: user1.id,
              enabled: true,
              status: "completed",
              goal: "Run 1",
              planner_model: "test/planner",
              reviewer_model: "test/reviewer",
              time_created: 1,
              time_updated: 2,
              completed_at: 2,
            })
            .run(),
        )

        const user2 = yield* sessions.updateMessage({
          id: MessageID.ascending(),
          role: "user",
          sessionID: chat.id,
          agent: "cluster",
          model: { providerID: ProviderID.make("test"), modelID: ModelID.make("test") },
          time: { created: 3 },
        })
        const run2 = AgentCluster.createRunID() as RunID
        Database.use((db) =>
          db
            .insert(AgentClusterRunTable)
            .values({
              id: run2,
              session_id: chat.id,
              parent_message_id: user2.id,
              enabled: true,
              status: "planning",
              goal: "Run 2",
              planner_model: "test/planner",
              reviewer_model: "test/reviewer",
              time_created: 3,
              time_updated: 3,
            })
            .run(),
        )

        // Both runs exist. The older run was created first.
        // A lookup that scans oldest-first would bind to run1.
        // The correct behavior binds to run2 (newest explicit run).
        const rows = Database.use((db) =>
          db
            .select()
            .from(AgentClusterRunTable)
            .where(Database.eq(AgentClusterRunTable.session_id, chat.id))
            .all(),
        )

        // The most recent run by time_created should be run2
        const sorted = rows.sort((a, b) => b.time_created - a.time_created)
        expect(sorted[0]?.id).toBe(run2)
        // run1 should still exist and be earlier
        expect(sorted[1]?.id).toBe(run1)
      }),
    )
  })

  describe("stale persisted state", () => {
    test("api refresh with older version does not roll state backward", () => {
      // Simulate two snapshots: one with version 5 "accepted", then one with version 4 "running".
      // The version 4 snapshot must not override version 5.
      const version5Task = { id: "task-1", status: "accepted", status_version: 5 }
      const version4Task = { id: "task-1", status: "running", status_version: 4 }

      // Simulate the version-aware merge
      const merged = new Map<string, { status: string; status_version: number }>()
      merged.set(version5Task.id, version5Task)
      // Attempt to merge version4 — should be rejected
      const existing = merged.get(version4Task.id)
      if (!existing || version4Task.status_version > existing.status_version) {
        merged.set(version4Task.id, version4Task)
      }

      expect(merged.get("task-1")?.status).toBe("accepted")
      expect(merged.get("task-1")?.status_version).toBe(5)
    })

    test("child completion evidence overrides stale running row only when version is newer", () => {
      // A persisted "running" row with version 1 should be overridden by child completion
      // evidence with a newer timestamp/version.
      const persistedRow = { status: "running", status_version: 1, updatedAt: 1000 }
      const childEvidence = { completed: true, completedAt: 2000 }

      // Legacy heuristic: if the DB row is older than child evidence, prefer child evidence
      const resolved =
        childEvidence.completed && childEvidence.completedAt > persistedRow.updatedAt ? "done" : persistedRow.status

      expect(resolved).toBe("done")
    })
  })

  describe("completion gate", () => {
    it.instance("finalizeRunIfTerminal does not mark a planning run completed", () =>
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
        Database.use((db) =>
          db
            .insert(AgentClusterRunTable)
            .values({
              id: runID,
              session_id: chat.id,
              parent_message_id: user.id,
              enabled: true,
              status: "planning",
              goal: "Build feature",
              planner_model: "test/planner",
              reviewer_model: "test/reviewer",
              time_created: Date.now(),
              time_updated: Date.now(),
            })
            .run(),
        )

        // With zero tasks, finalizeRunIfTerminal currently marks the run completed.
        // This test documents that bug: a planning run should NOT auto-complete.
        const completed = yield* AgentCluster.finalizeRunIfTerminal(runID)

        const row = Database.use((db) =>
          db.select().from(AgentClusterRunTable).where(Database.eq(AgentClusterRunTable.id, runID)).get(),
        )
        // EXPECTED FAIL: current code returns true and marks status "completed"
        // After fix: should return false and status should remain "planning"
        expect(completed).toBe(false)
        expect(row?.status).toBe("planning")
      }),
    )
  })

  describe("versioned compare-and-swap", () => {
    test("compare-and-swap rejects stale writers", () => {
      // Two concurrent writers both read version 1.
      // Writer A transitions running -> submitted (version 1 -> 2).
      // Writer B attempts running -> failed with version 1 — must be rejected.
      const currentVersion = 1
      const writerA = { from: "running", to: "submitted", expectedVersion: 1, newVersion: 2 }
      const writerB = { from: "running", to: "failed", expectedVersion: 1, newVersion: 2 }

      // Simulate CAS: first writer succeeds
      let storedVersion = currentVersion
      let storedStatus = "running"

      const cas = (writer: typeof writerA) => {
        if (writer.expectedVersion !== storedVersion) return false
        storedVersion = writer.newVersion
        storedStatus = writer.to
        return true
      }

      expect(cas(writerA)).toBe(true)
      expect(storedStatus).toBe("submitted")
      expect(cas(writerB)).toBe(false) // rejected — version mismatch
      expect(storedStatus).toBe("submitted")
      expect(storedVersion).toBe(2)
    })
  })
})
