// @ts-nocheck -- superseded by session-graph lifecycle coverage in cluster.test.ts.
import { describe, expect } from "bun:test"
import { Session } from "@/session/session"
import { MessageID, SessionID } from "@/session/schema"
import { AgentClusterRunTable, AgentClusterTaskTable } from "@/agent-cluster/cluster.sql"
import { AgentCluster } from "@/agent-cluster/cluster"
import { AgentClusterRuntime } from "@/agent-cluster/runtime"
import { ModelID, ProviderID } from "@/provider/schema"
import { Database } from "@/storage/db"
import { Effect } from "effect"
import { testEffect } from "../lib/effect"
import type { RunID, TaskID } from "@/agent-cluster/schema"

const it = testEffect(Session.defaultLayer)
const dispatchConfig = {
  simple_model: "test/simple",
  simple_variant: "low",
  complex_model: "test/complex",
  visual_model: "test/visual",
  visual_variant: "high",
}

/**
 * End-to-end tests exercising the full multi-agent cluster lifecycle
 * through the programmatic API. These verify:
 *   1. Plan persistence and task step separation
 *   2. Task dispatch (markTaskRunning) and the cluster state endpoint
 *   3. Result submission and run status transitions
 *   4. Review → revision_requested flow (same child resumed)
 *   5. Review → accepted flow and run completion
 *   6. Step gating for multi-step plans
 *   7. Unknown-task-id recovery (Bug 4)
 */
describe.skip("legacy run-scoped multi-agent E2E lifecycle", () => {
  it.instance("Bug 1&3: step grouping and task status in cluster state endpoint", () =>
    Effect.gen(function* () {
      const sessions = yield* Session.Service
      const chat = yield* sessions.create({ title: "E2E step grouping test" })
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
      Database.use((db) =>
        db
          .insert(AgentClusterRunTable)
          .values({
            id: runID,
            session_id: chat.id,
            parent_message_id: user.id,
            enabled: true,
            status: "dispatching",
            goal: "Write a report on climate change",
            planner_model: "test/planner",
            reviewer_model: "test/reviewer",
            time_created: now,
            time_updated: now,
          })
          .run(),
      )

      // Persist a plan with 3 steps, 5 tasks
      const plan = {
        goal: "Write a report on climate change",
        tasks: [
          {
            id: AgentClusterRuntime.coerceTaskID("research-terrain"),
            step: 1,
            title: "Research terrain",
            role: "researcher" as const,
            complexity: "simple" as const,
            model: "test/simple",
            dependencies: [],
            prompt: "Research terrain data",
            acceptanceCriteria: ["terrain data collected"],
            expectedArtifacts: ["terrain.md"],
          },
          {
            id: AgentClusterRuntime.coerceTaskID("research-weather"),
            step: 1,
            title: "Research weather",
            role: "researcher" as const,
            complexity: "simple" as const,
            model: "test/simple",
            dependencies: [],
            prompt: "Research weather data",
            acceptanceCriteria: ["weather data collected"],
            expectedArtifacts: ["weather.md"],
          },
          {
            id: AgentClusterRuntime.coerceTaskID("analyze"),
            step: 2,
            title: "Analyze data",
            role: "analyst" as const,
            complexity: "complex" as const,
            model: "test/complex",
            dependencies: ["research-terrain", "research-weather"],
            prompt: "Analyze combined data",
            acceptanceCriteria: ["analysis complete"],
            expectedArtifacts: ["analysis.md"],
          },
          {
            id: AgentClusterRuntime.coerceTaskID("write-draft"),
            step: 3,
            title: "Write draft",
            role: "writer" as const,
            complexity: "complex" as const,
            model: "test/complex",
            dependencies: ["analyze"],
            prompt: "Write the draft",
            acceptanceCriteria: ["draft complete"],
            expectedArtifacts: ["draft.md"],
          },
          {
            id: AgentClusterRuntime.coerceTaskID("format-final"),
            step: 3,
            title: "Format final",
            role: "pdf" as const,
            complexity: "complex" as const,
            model: "test/complex",
            dependencies: ["analyze"],
            prompt: "Format the final PDF",
            acceptanceCriteria: ["PDF formatted"],
            expectedArtifacts: ["report.pdf"],
          },
        ],
      }

      yield* AgentCluster.persistPlan({ runID, plan: plan as any })

      // Mark step 1 tasks as running
      const child1ID = SessionID.make("ses_child_terrain")
      const child2ID = SessionID.make("ses_child_weather")
      yield* AgentCluster.markTaskRunning({ runID, taskID: "research-terrain", childSessionID: child1ID })
      yield* AgentCluster.markTaskRunning({ runID, taskID: "research-weather", childSessionID: child2ID })

      // Verify cluster state via getSessionState
      const state = yield* AgentCluster.getSessionState(chat.id)
      expect(state.runs.length).toBe(1)
      expect(state.runs[0]?.status).toBe("dispatching")

      // All 5 tasks should be present
      expect(state.tasks.length).toBe(5)

      // Step 1 tasks should be running, not combined with others
      const terrain = state.tasks.find((t) => t.id === "research-terrain")
      const weather = state.tasks.find((t) => t.id === "research-weather")
      const analyze = state.tasks.find((t) => t.id === "analyze")
      const write = state.tasks.find((t) => t.id === "write-draft")
      const format = state.tasks.find((t) => t.id === "format-final")

      expect(terrain?.status).toBe("running")
      expect(terrain?.step).toBe(1)
      expect(weather?.status).toBe("running")
      expect(weather?.step).toBe(1)
      expect(analyze?.status).toBe("planned")
      expect(analyze?.step).toBe(2)
      expect(write?.status).toBe("planned")
      expect(write?.step).toBe(3)
      expect(format?.status).toBe("planned")
      expect(format?.step).toBe(3)

      // Verify dependencies are preserved
      expect(analyze?.dependencies).toContain("research-terrain")
      expect(analyze?.dependencies).toContain("research-weather")
      expect(write?.dependencies).toContain("analyze")
      expect(format?.dependencies).toContain("analyze")
    }),
  )

  it.instance("Bug 2: submitted tasks show correct status, step 2 only dispatches after step 1 done", () =>
    Effect.gen(function* () {
      const sessions = yield* Session.Service
      const chat = yield* sessions.create({ title: "E2E status transition test" })
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
            status: "dispatching",
            goal: "Two step plan",
            planner_model: "test/planner",
            reviewer_model: "test/reviewer",
            time_created: Date.now(),
            time_updated: Date.now(),
          })
          .run(),
      )

      const plan = {
        goal: "Two step plan",
        tasks: [
          {
            id: AgentClusterRuntime.coerceTaskID("step1-research"),
            step: 1,
            title: "Research",
            role: "researcher" as const,
            complexity: "simple" as const,
            model: "test/simple",
            dependencies: [],
            prompt: "Research the topic",
            acceptanceCriteria: ["data collected"],
            expectedArtifacts: ["research.md"],
          },
          {
            id: AgentClusterRuntime.coerceTaskID("step2-write"),
            step: 2,
            title: "Write",
            role: "writer" as const,
            complexity: "simple" as const,
            model: "test/simple",
            dependencies: ["step1-research"],
            prompt: "Write the report",
            acceptanceCriteria: ["report written"],
            expectedArtifacts: ["report.md"],
          },
        ],
      }

      yield* AgentCluster.persistPlan({ runID, plan: plan as any })

      // Dispatch step 1
      yield* AgentCluster.markTaskRunning({
        runID,
        taskID: "step1-research",
        childSessionID: SessionID.make("ses_research"),
      })

      // Submit step 1 result (not yet accepted)
      yield* AgentCluster.submitTaskResult({
        runID,
        taskID: "step1-research",
        childSessionID: SessionID.make("ses_research"),
        summary: "Research data collected",
      })

      // Step gate should block step 2 until step 1 is accepted
      const state = yield* AgentCluster.getSessionState(chat.id)
      const gate = AgentClusterRuntime.stepGate(
        state.tasks.map((t) => ({ id: t.id, step: t.step ?? 1, status: t.status })),
        2,
      )
      expect(gate.allowed).toBe(false)
      expect(gate.pending).toContain("step1-research")

      // Now simulate reviewing and accepting step 1
      Database.use((db) =>
        db
          .update(AgentClusterTaskTable)
          .set({ status: "accepted", time_updated: Date.now() })
          .where(Database.eq(AgentClusterTaskTable.id, "step1-research" as any))
          .run(),
      )

      const stateAfter = yield* AgentCluster.getSessionState(chat.id)
      const gateAfter = AgentClusterRuntime.stepGate(
        stateAfter.tasks.map((t) => ({ id: t.id, step: t.step ?? 1, status: t.status })),
        2,
      )
      expect(gateAfter.allowed).toBe(true)
      expect(gateAfter.pending).toEqual([])

      // Now dispatch step 2
      yield* AgentCluster.markTaskRunning({
        runID,
        taskID: "step2-write",
        childSessionID: SessionID.make("ses_write"),
      })

      const stateFinal = yield* AgentCluster.getSessionState(chat.id)
      const write = stateFinal.tasks.find((t) => t.id === "step2-write")
      expect(write?.status).toBe("running")
      expect(write?.step).toBe(2)
    }),
  )

  it.instance("Review flow: accept all tasks and complete the run", () =>
    Effect.gen(function* () {
      const sessions = yield* Session.Service
      const chat = yield* sessions.create({ title: "E2E accept test" })
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
            status: "reviewing",
            goal: "Single step plan",
            planner_model: "test/planner",
            reviewer_model: "test/reviewer",
            time_created: Date.now(),
            time_updated: Date.now(),
          })
          .run(),
      )

      const plan = {
        goal: "Single step plan",
        tasks: [
          {
            id: AgentClusterRuntime.coerceTaskID("single-task"),
            step: 1,
            title: "Single task",
            role: "coder" as const,
            complexity: "simple" as const,
            model: "test/simple",
            dependencies: [],
            prompt: "Build the feature",
            acceptanceCriteria: ["tests pass"],
            expectedArtifacts: ["feature.ts"],
          },
        ],
      }

      yield* AgentCluster.persistPlan({ runID, plan: plan as any })
      yield* AgentCluster.markTaskRunning({
        runID,
        taskID: "single-task" as TaskID,
        childSessionID: SessionID.make("ses_single"),
      })
      yield* AgentCluster.submitTaskResult({
        runID,
        taskID: "single-task" as TaskID,
        childSessionID: SessionID.make("ses_single"),
        summary: "Feature built and tested",
      })

      // Accept the task
      Database.use((db) =>
        db
          .update(AgentClusterTaskTable)
          .set({ status: "accepted", last_event: "accepted", time_updated: Date.now() })
          .where(Database.eq(AgentClusterTaskTable.id, "single-task" as any))
          .run(),
      )

      // Run should now be marked as completed
      const completed = yield* AgentCluster.finalizeRunIfTerminal(runID)
      expect(completed).toBe(true)

      const state = yield* AgentCluster.getSessionState(chat.id)
      expect(state.runs[0]?.status).toBe("completed")
      expect(state.tasks[0]?.status).toBe("accepted")
    }),
  )

  it.instance("Review flow: revision_requested → revising → resubmit → accepted", () =>
    Effect.gen(function* () {
      const sessions = yield* Session.Service
      const chat = yield* sessions.create({ title: "E2E revision test" })
      const user = yield* sessions.updateMessage({
        id: MessageID.ascending(),
        role: "user",
        sessionID: chat.id,
        agent: "cluster",
        model: { providerID: ProviderID.make("test"), modelID: ModelID.make("test") },
        time: { created: Date.now() },
      })
      const runID = AgentCluster.createRunID() as RunID
      const childID = SessionID.make("ses_revise_me")
      Database.use((db) => {
        const now = Date.now()
        db.insert(AgentClusterRunTable)
          .values({
            id: runID,
            session_id: chat.id,
            parent_message_id: user.id,
            enabled: true,
            status: "reviewing",
            goal: "Revision test",
            planner_model: "test/planner",
            reviewer_model: "test/reviewer",
            time_created: now,
            time_updated: now,
          })
          .run()
        db.insert(AgentClusterTaskTable)
          .values({
            id: "needs-revision" as TaskID,
            run_id: runID,
            role: "coder",
            title: "Needs revision",
            prompt: "Fix the bug",
            complexity: "simple",
            model: "test/simple",
            status: "submitted",
            child_session_id: childID,
            acceptance_criteria: ["bug fixed", "tests pass"],
            artifact_paths: [],
            time_created: now,
            time_updated: now,
          })
          .run()
      })

      // 1. Mark task as revision_requested (what agent_cluster_review does)
      Database.use((db) =>
        db
          .update(AgentClusterTaskTable)
          .set({
            status: "revision_requested",
            review_issues: ["Missing error handling"],
            review_round: 1,
            time_updated: Date.now(),
          })
          .where(Database.eq(AgentClusterTaskTable.id, "needs-revision" as any))
          .run(),
      )

      // 2. Resume the same child session for revision
      // prepareTaskDispatch with the child session ID should find the task
      const dispatch = yield* AgentCluster.prepareTaskDispatch({
        runID,
        requestedTaskID: String(childID), // use the ses_... ID to resume
        prompt: "Add error handling as requested",
        config: dispatchConfig,
      })

      // Should find the task via child_session_id match
      expect(dispatch.taskID).toBe("needs-revision" as TaskID)

      // 3. Verify status updated to revising
      const taskAfterRevise = Database.use((db) =>
        db
          .select()
          .from(AgentClusterTaskTable)
          .where(Database.eq(AgentClusterTaskTable.id, "needs-revision" as any))
          .get(),
      )
      expect(taskAfterRevise?.status).toBe("revising")

      // 4. Mark as running (what markTaskRunning does when resuming)
      yield* AgentCluster.markTaskRunning({
        runID,
        taskID: "needs-revision",
        childSessionID: childID,
      })

      const taskRunning = Database.use((db) =>
        db
          .select()
          .from(AgentClusterTaskTable)
          .where(Database.eq(AgentClusterTaskTable.id, "needs-revision" as any))
          .get(),
      )
      // Should stay "revising" when resuming (not change to "running")
      expect(taskRunning?.status).toBe("revising")

      // 5. Submit revision
      yield* AgentCluster.submitTaskResult({
        runID,
        taskID: "needs-revision",
        childSessionID: childID,
        summary: "Added error handling, all tests pass",
      })

      const taskResubmitted = Database.use((db) =>
        db
          .select()
          .from(AgentClusterTaskTable)
          .where(Database.eq(AgentClusterTaskTable.id, "needs-revision" as any))
          .get(),
      )
      expect(taskResubmitted?.status).toBe("submitted")
      expect(taskResubmitted?.result_summary).toBe("Added error handling, all tests pass")

      // 6. Accept after revision
      Database.use((db) =>
        db
          .update(AgentClusterTaskTable)
          .set({ status: "accepted", review_issues: [], time_updated: Date.now() })
          .where(Database.eq(AgentClusterTaskTable.id, "needs-revision" as any))
          .run(),
      )

      const completed = yield* AgentCluster.finalizeRunIfTerminal(runID)
      expect(completed).toBe(true)
    }),
  )

  it.instance("Bug 4: prepareTaskDispatch finds task by plan id AND child session id", () =>
    Effect.gen(function* () {
      const sessions = yield* Session.Service
      const chat = yield* sessions.create({ title: "E2E task lookup test" })
      const user = yield* sessions.updateMessage({
        id: MessageID.ascending(),
        role: "user",
        sessionID: chat.id,
        agent: "cluster",
        model: { providerID: ProviderID.make("test"), modelID: ModelID.make("test") },
        time: { created: Date.now() },
      })
      const runID = AgentCluster.createRunID() as RunID
      const childID = SessionID.make("ses_child_task")
      Database.use((db) => {
        const now = Date.now()
        db.insert(AgentClusterRunTable)
          .values({
            id: runID,
            session_id: chat.id,
            parent_message_id: user.id,
            enabled: true,
            status: "dispatching",
            goal: "Task lookup test",
            planner_model: "test/planner",
            reviewer_model: "test/reviewer",
            time_created: now,
            time_updated: now,
          })
          .run()
        db.insert(AgentClusterTaskTable)
          .values({
            id: "my-task" as TaskID,
            run_id: runID,
            role: "researcher",
            title: "Research",
            prompt: "Do research",
            complexity: "simple",
            model: "-",
            status: "planned",
            child_session_id: childID,
            acceptance_criteria: ["done"],
            artifact_paths: [],
            time_created: now,
            time_updated: now,
          })
          .run()
      })

      // Lookup by plan task ID
      const byPlanID = yield* AgentCluster.prepareTaskDispatch({
        runID,
        requestedTaskID: "my-task",
        prompt: "Do the research",
        config: dispatchConfig,
      })
      expect(byPlanID.taskID).toBe("my-task" as TaskID)
      expect(byPlanID.prompt).toContain("Do the research")
      expect(byPlanID.model).toBe("test/simple")
      expect(byPlanID.variant).toBe("low")

      // Lookup by child session ID (what the planner does for revisions)
      const byChildID = yield* AgentCluster.prepareTaskDispatch({
        runID,
        requestedTaskID: String(childID),
        prompt: "Do the research",
        config: dispatchConfig,
      })
      expect(byChildID.taskID).toBe("my-task" as TaskID)
      expect(byChildID.model).toBe("test/simple")
      expect(byChildID.variant).toBe("low")

      Database.use((db) =>
        db
          .update(AgentClusterTaskTable)
          .set({ model: "test/explicit" })
          .where(Database.eq(AgentClusterTaskTable.id, "my-task" as any))
          .run(),
      )
      const explicitModel = yield* AgentCluster.prepareTaskDispatch({
        runID,
        requestedTaskID: "my-task",
        prompt: "Do the research",
        config: dispatchConfig,
      })
      expect(explicitModel.model).toBe("test/explicit")

      Database.use((db) =>
        db
          .update(AgentClusterTaskTable)
          .set({ model: "-", role: "picture_searcher" })
          .where(Database.eq(AgentClusterTaskTable.id, "my-task" as any))
          .run(),
      )
      const visualModel = yield* AgentCluster.prepareTaskDispatch({
        runID,
        requestedTaskID: "my-task",
        prompt: "Find reference images",
        config: dispatchConfig,
      })
      expect(visualModel.model).toBe("test/visual")
      expect(visualModel.variant).toBe("high")

      // Unknown task ID should fail
      const unknownResult = yield* AgentCluster.prepareTaskDispatch({
        runID,
        requestedTaskID: "unknown-task",
        prompt: "Do something",
        config: dispatchConfig,
      }).pipe(
        Effect.match({
          onSuccess: () => "success",
          onFailure: (e) => String(e),
        }),
      )
      expect(unknownResult).toContain("Unknown cluster task")
    }),
  )

  it.instance("Step gate: cannot dispatch task with rejected dependencies", () =>
    Effect.gen(function* () {
      const sessions = yield* Session.Service
      const chat = yield* sessions.create({ title: "E2E rejected dep test" })
      const user = yield* sessions.updateMessage({
        id: MessageID.ascending(),
        role: "user",
        sessionID: chat.id,
        agent: "cluster",
        model: { providerID: ProviderID.make("test"), modelID: ModelID.make("test") },
        time: { created: Date.now() },
      })
      const runID = AgentCluster.createRunID() as RunID
      Database.use((db) => {
        const now = Date.now()
        db.insert(AgentClusterRunTable)
          .values({
            id: runID,
            session_id: chat.id,
            parent_message_id: user.id,
            enabled: true,
            status: "reviewing",
            goal: "Failed dep test",
            planner_model: "test/planner",
            reviewer_model: "test/reviewer",
            time_created: now,
            time_updated: now,
          })
          .run()
        db.insert(AgentClusterTaskTable)
          .values({
            id: "good-dep" as TaskID,
            run_id: runID,
            role: "researcher",
            title: "Good dep",
            prompt: "Research",
            complexity: "simple",
            model: "test/simple",
            status: "accepted",
            step: 1,
            acceptance_criteria: [],
            artifact_paths: [],
            time_created: now,
            time_updated: now,
          })
          .run()
        db.insert(AgentClusterTaskTable)
          .values({
            id: "bad-dep" as TaskID,
            run_id: runID,
            role: "researcher",
            title: "Bad dep",
            prompt: "Also research",
            complexity: "simple",
            model: "test/simple",
            status: "failed",
            step: 1,
            acceptance_criteria: [],
            artifact_paths: [],
            time_created: now,
            time_updated: now,
          })
          .run()
        db.insert(AgentClusterTaskTable)
          .values({
            id: "depends-on-bad" as TaskID,
            run_id: runID,
            role: "analyst",
            title: "Depends on bad",
            prompt: "Analyze",
            complexity: "simple",
            model: "test/simple",
            status: "planned",
            step: 2,
            dependencies: ["good-dep", "bad-dep"],
            acceptance_criteria: [],
            artifact_paths: [],
            time_created: now,
            time_updated: now,
          })
          .run()
      })

      // Step gate should block because step 1 has a failed task
      const taskRows = Database.use((db) =>
        db.select().from(AgentClusterTaskTable).where(Database.eq(AgentClusterTaskTable.run_id, runID)).all(),
      )
      const gate = AgentClusterRuntime.stepGate(
        taskRows.map((t) => ({ id: t.id, step: t.step, status: t.status })),
        2,
      )
      expect(gate.allowed).toBe(false)
      expect(gate.rejected).toContain("bad-dep")

      // Trying to dispatch the dependent task should fail
      const dispatchResult = yield* AgentCluster.prepareTaskDispatch({
        runID,
        requestedTaskID: "depends-on-bad",
        prompt: "Analyze",
        config: dispatchConfig,
      }).pipe(
        Effect.match({
          onSuccess: () => "success",
          onFailure: (e) => String(e),
        }),
      )
      expect(dispatchResult).toContain("Step gate blocked")
    }),
  )

  it.instance("Complete run: all steps accepted marks run as completed", () =>
    Effect.gen(function* () {
      const sessions = yield* Session.Service
      const chat = yield* sessions.create({ title: "E2E complete run test" })
      const user = yield* sessions.updateMessage({
        id: MessageID.ascending(),
        role: "user",
        sessionID: chat.id,
        agent: "cluster",
        model: { providerID: ProviderID.make("test"), modelID: ModelID.make("test") },
        time: { created: Date.now() },
      })
      const runID = AgentCluster.createRunID() as RunID
      Database.use((db) => {
        const now = Date.now()
        db.insert(AgentClusterRunTable)
          .values({
            id: runID,
            session_id: chat.id,
            parent_message_id: user.id,
            enabled: true,
            status: "reviewing",
            goal: "Ship feature",
            planner_model: "test/planner",
            reviewer_model: "test/reviewer",
            time_created: now,
            time_updated: now,
          })
          .run()
        for (const t of [
          { id: "task-a" as TaskID, step: 1, status: "accepted", deps: [] as string[] },
          { id: "task-b" as TaskID, step: 1, status: "accepted", deps: [] as string[] },
          { id: "task-c" as TaskID, step: 2, status: "accepted", deps: ["task-a"] },
        ]) {
          db.insert(AgentClusterTaskTable)
            .values({
              id: t.id,
              run_id: runID,
              role: "coder",
              title: t.id,
              prompt: `Do ${t.id}`,
              complexity: "simple",
              model: "test/simple",
              status: t.status,
              step: t.step,
              dependencies: t.deps,
              acceptance_criteria: ["done"],
              artifact_paths: [],
              time_created: now,
              time_updated: now,
            } as any)
            .run()
        }
      })

      const completed = yield* AgentCluster.finalizeRunIfTerminal(runID)
      expect(completed).toBe(true)

      const run = Database.use((db) =>
        db.select().from(AgentClusterRunTable).where(Database.eq(AgentClusterRunTable.id, runID)).get(),
      )
      expect(run?.status).toBe("completed")
      expect(run?.completed_at).toBeTruthy()
    }),
  )

  it.instance("Full multi-step lifecycle: dispatch → review → next step → complete", () =>
    Effect.gen(function* () {
      const sessions = yield* Session.Service
      const chat = yield* sessions.create({ title: "E2E full multi-step lifecycle" })
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
      Database.use((db) =>
        db
          .insert(AgentClusterRunTable)
          .values({
            id: runID,
            session_id: chat.id,
            parent_message_id: user.id,
            enabled: true,
            status: "dispatching",
            goal: "Multi-step research and writing project",
            planner_model: "test/planner",
            reviewer_model: "test/reviewer",
            time_created: now,
            time_updated: now,
          })
          .run(),
      )

      // Create a 2-step plan: step 1 has two parallel research tasks,
      // step 2 has a writer task that depends on both research tasks.
      const plan = {
        goal: "Multi-step research and writing project",
        tasks: [
          {
            id: AgentClusterRuntime.coerceTaskID("research-market"),
            step: 1,
            title: "Research market trends",
            role: "researcher" as const,
            complexity: "simple" as const,
            model: "test/simple",
            dependencies: [],
            prompt: "Research current market trends",
            acceptanceCriteria: ["Market data collected with citations"],
            expectedArtifacts: ["market.md"],
          },
          {
            id: AgentClusterRuntime.coerceTaskID("research-competitors"),
            step: 1,
            title: "Research competitor landscape",
            role: "researcher" as const,
            complexity: "simple" as const,
            model: "test/simple",
            dependencies: [],
            prompt: "Research competitor landscape",
            acceptanceCriteria: ["Competitor analysis complete"],
            expectedArtifacts: ["competitors.md"],
          },
          {
            id: AgentClusterRuntime.coerceTaskID("write-report"),
            step: 2,
            title: "Write final report",
            role: "writer" as const,
            complexity: "complex" as const,
            model: "test/complex",
            dependencies: ["research-market", "research-competitors"],
            prompt: "Synthesize research into a final report",
            acceptanceCriteria: ["Report synthesizes both research inputs", "Report is well-structured"],
            expectedArtifacts: ["report.md"],
          },
        ],
      }

      yield* AgentCluster.persistPlan({ runID, plan: plan as any })

      // === STEP 1: Dispatch both research tasks ===
      const childMarketID = SessionID.make("ses_child_market")
      const childCompetitorsID = SessionID.make("ses_child_competitors")
      yield* AgentCluster.markTaskRunning({ runID, taskID: "research-market", childSessionID: childMarketID })
      yield* AgentCluster.markTaskRunning({ runID, taskID: "research-competitors", childSessionID: childCompetitorsID })

      // Verify step 1 tasks are running, step 2 is still planned
      let state = yield* AgentCluster.getSessionState(chat.id)
      const market = state.tasks.find((t) => t.id === "research-market")
      const competitors = state.tasks.find((t) => t.id === "research-competitors")
      const write = state.tasks.find((t) => t.id === "write-report")
      expect(market?.status).toBe("running")
      expect(competitors?.status).toBe("running")
      expect(write?.status).toBe("planned")

      // Step gate must block step 2 while step 1 tasks are not yet accepted
      const gateBlocked = AgentClusterRuntime.stepGate(
        state.tasks.map((t) => ({ id: t.id, step: t.step ?? 1, status: t.status })),
        2,
      )
      expect(gateBlocked.allowed).toBe(false)
      expect(gateBlocked.pending).toContain("research-market")
      expect(gateBlocked.pending).toContain("research-competitors")

      // === Submit step 1 results ===
      yield* AgentCluster.submitTaskResult({
        runID,
        taskID: "research-market",
        childSessionID: childMarketID,
        summary: "Market trends research complete",
      })
      yield* AgentCluster.submitTaskResult({
        runID,
        taskID: "research-competitors",
        childSessionID: childCompetitorsID,
        summary: "Competitor analysis complete",
      })

      // Step gate STILL blocks (tasks are submitted, not accepted)
      state = yield* AgentCluster.getSessionState(chat.id)
      const gateStillBlocked = AgentClusterRuntime.stepGate(
        state.tasks.map((t) => ({ id: t.id, step: t.step ?? 1, status: t.status })),
        2,
      )
      expect(gateStillBlocked.allowed).toBe(false)

      // === Review and accept step 1 tasks ===
      Database.use((db) => {
        db.update(AgentClusterTaskTable)
          .set({ status: "accepted", time_updated: Date.now() })
          .where(
            Database.and(
              Database.eq(AgentClusterTaskTable.run_id, runID),
              Database.eq(AgentClusterTaskTable.id, "research-market" as any),
            ),
          )
          .run()
        db.update(AgentClusterTaskTable)
          .set({ status: "accepted", time_updated: Date.now() })
          .where(
            Database.and(
              Database.eq(AgentClusterTaskTable.run_id, runID),
              Database.eq(AgentClusterTaskTable.id, "research-competitors" as any),
            ),
          )
          .run()
      })

      // Step gate now ALLOWS step 2
      state = yield* AgentCluster.getSessionState(chat.id)
      const gateAllowed = AgentClusterRuntime.stepGate(
        state.tasks.map((t) => ({ id: t.id, step: t.step ?? 1, status: t.status })),
        2,
      )
      expect(gateAllowed.allowed).toBe(true)
      expect(gateAllowed.pending).toEqual([])

      // Run should NOT be completed yet (step 2 task is still planned)
      const notDone = yield* AgentCluster.finalizeRunIfTerminal(runID)
      expect(notDone).toBe(false)

      // === STEP 2: Dispatch writer task ===
      const childWriteID = SessionID.make("ses_child_write")
      yield* AgentCluster.markTaskRunning({ runID, taskID: "write-report", childSessionID: childWriteID })

      // Run still not done (writer is running)
      const stillNotDone = yield* AgentCluster.finalizeRunIfTerminal(runID)
      expect(stillNotDone).toBe(false)

      // Submit step 2 result
      yield* AgentCluster.submitTaskResult({
        runID,
        taskID: "write-report",
        childSessionID: childWriteID,
        summary: "Final report written",
      })

      // Still not done until accepted
      const notDoneYet = yield* AgentCluster.finalizeRunIfTerminal(runID)
      expect(notDoneYet).toBe(false)

      // Accept writer task
      Database.use((db) =>
        db
          .update(AgentClusterTaskTable)
          .set({ status: "accepted", time_updated: Date.now() })
          .where(
            Database.and(
              Database.eq(AgentClusterTaskTable.run_id, runID),
              Database.eq(AgentClusterTaskTable.id, "write-report" as any),
            ),
          )
          .run(),
      )

      // === VERIFY: Run should now be completed ===
      const done = yield* AgentCluster.finalizeRunIfTerminal(runID)
      expect(done).toBe(true)

      const run = Database.use((db) =>
        db.select().from(AgentClusterRunTable).where(Database.eq(AgentClusterRunTable.id, runID)).get(),
      )
      expect(run?.status).toBe("completed")
      expect(run?.completed_at).toBeTruthy()

      // All tasks should be accepted
      const finalState = yield* AgentCluster.getSessionState(chat.id)
      for (const task of finalState.tasks) {
        expect(task.status).toBe("accepted")
      }
    }),
  )
})
