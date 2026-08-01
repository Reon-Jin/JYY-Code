// @ts-nocheck -- runtime assertions cover branded API boundaries directly.
import { describe, expect, test } from "bun:test"
import { Deferred, Effect, Layer } from "effect"
import { AgentCluster } from "../../src/agent-cluster/cluster"
import { BackgroundJob } from "../../src/background/job"
import { ConfigAgentCluster } from "../../src/config/agent-cluster"
import { ClusterPrimaryPrompt, runInstructions, singleAgentPlanInstructions } from "../../src/agent-cluster/planner"
import { AgentClusterRuntime } from "../../src/agent-cluster/runtime"
import { Session } from "../../src/session/session"
import type { Session as SessionInfo } from "../../src/session/session"
import { SessionRunState } from "../../src/session/run-state"
import { SessionStatus } from "../../src/session/status"
import { AgentClusterTaskTable } from "../../src/agent-cluster/cluster.sql"
import * as Database from "../../src/storage/db"
import { awaitWithTimeout, testEffect } from "../lib/effect"

const it = testEffect(Session.defaultLayer)
const backgroundLayer = BackgroundJob.defaultLayer
const runStateLayer = SessionRunState.layer.pipe(
  Layer.provide(Layer.mergeAll(backgroundLayer, SessionStatus.defaultLayer)),
)
const interruptIt = testEffect(Layer.mergeAll(Session.defaultLayer, backgroundLayer, runStateLayer))
const dispatchConfig = { simple_model: "test/simple", complex_model: "test/complex", visual_model: "test/visual" }

describe("AgentCluster planner instructions", () => {
  test("cluster primary prompt covers the orchestration contract", () => {
    expect(ClusterPrimaryPrompt).toContain("PLAN-FIRST")
    expect(ClusterPrimaryPrompt).toContain("agent_cluster_review")
    expect(ClusterPrimaryPrompt).toContain("task tool")
    expect(ClusterPrimaryPrompt).toContain("MANDATORY REVIEW")
  })

  test("includes session graph scheduling rules", () => {
    const text = runInstructions({
      sessionID: "ses_root",
      artifactDir: "/tmp/artifacts",
      simpleModel: "provider/simple",
      complexModel: "provider/complex",
      visualModel: "provider/visual",
      maxSubagents: 10,
      maxConcurrency: 3,
      maxReviewRounds: 2,
      taskGraph: [
        {
          id: "task-recover",
          step: 4,
          status: "failed",
          title: "Recover task",
          role: "coder",
          prompt: "Recover the task with the reported issue",
          complexity: "simple",
          model: "test/simple",
          dependencies: ["task-previous"],
          acceptance_criteria: ["artifact is present"],
          artifact_paths: ["result.txt"],
          review_issues: ["missing artifact"],
          last_event: "failed",
        },
      ],
    })
    expect(text).toContain("Dispatch only the smallest unfinished step")
    expect(text).toContain("This session task graph is durable")
    expect(text).toContain("Never create a duplicate existing task")
    expect(text).toContain("global Step numbers")
    expect(text).toContain("never expect the runtime to translate local steps")
    expect(text).toContain("task-recover")
    expect(text).toContain("cancelTaskIDs")
    expect(text).toContain("force=true")
  })
})

describe("AgentCluster.canUseAgentCluster", () => {
  const baseConfig = ConfigAgentCluster.Default
  const baseSession = {
    title: "Help me write a function",
    agent: "build" as const,
    path: undefined,
    multiAgent: undefined as boolean | undefined,
    parentID: undefined,
  } satisfies Pick<SessionInfo.Info, "title" | "agent" | "path" | "multiAgent" | "parentID">

  test("respects config and excludes child sessions", () => {
    expect(AgentCluster.canUseAgentCluster({ session: baseSession, config: { ...baseConfig, enabled: false } })).toBe(
      false,
    )
    expect(
      AgentCluster.canUseAgentCluster({
        session: { ...baseSession, parentID: "ses_parent" as any },
        config: baseConfig,
        requested: true,
      }),
    ).toBe(false)
    expect(AgentCluster.canUseAgentCluster({ session: baseSession, config: baseConfig, requested: true })).toBe(true)
  })
})

describe("AgentCluster.canUseSingleAgentPlan", () => {
  const baseSession = {
    title: "Help me write a function",
    agent: "build" as const,
    path: undefined,
    parentID: undefined,
  } satisfies Pick<SessionInfo.Info, "title" | "agent" | "path" | "parentID">

  test("applies to native build root sessions only", () => {
    expect(AgentCluster.canUseSingleAgentPlan({ session: baseSession, agent: "build" })).toBe(true)
    expect(AgentCluster.canUseSingleAgentPlan({ session: baseSession, agent: "plan" })).toBe(false)
    expect(AgentCluster.canUseSingleAgentPlan({ session: baseSession, noReply: true })).toBe(false)
    expect(
      AgentCluster.canUseSingleAgentPlan({ session: { ...baseSession, parentID: "ses_parent" as any } }),
    ).toBe(false)
  })

  test("single-agent plan instructions require self-execution without removed tools", () => {
    const text = singleAgentPlanInstructions({ sessionID: "ses_root" })
    expect(text).toContain("execution_mode: single-agent")
    expect(text).toContain("SELF-EXECUTION")
    expect(text).toContain("Subagent dispatch is unavailable")
    expect(text).toContain("plan_update")
    expect(text).not.toContain("agent_cluster_review")
  })
})

describe("AgentClusterRuntime", () => {
  const task = (id: string, step: number, dependencies: string[] = []) => ({
    id: AgentClusterRuntime.coerceTaskID(id),
    step,
    title: id,
    role: "researcher" as const,
    complexity: "simple" as const,
    model: "test/simple",
    dependencies: dependencies.map(AgentClusterRuntime.coerceTaskID),
    prompt: `Do ${id}`,
    acceptanceCriteria: [],
    expectedArtifacts: [],
  })

  test("only makes the earliest unfinished wave ready", () => {
    const plan = { goal: "Test", tasks: [task("research", 1), task("write", 2, ["research"])] }
    expect(AgentClusterRuntime.nextReadyBatch(plan, { completed: [] }).tasks.map((item) => item.id)).toEqual([
      "research",
    ])
    expect(
      AgentClusterRuntime.nextReadyBatch(plan, { completed: ["research" as any] }).tasks.map((item) => item.id),
    ).toEqual(["write"])
  })

  test("rejects invalid graph topology", () => {
    const result = AgentClusterRuntime.validatePlan(
      { goal: "Bad", tasks: [task("same-step", 1, ["other"]), task("other", 1)] },
      { maxSubagents: 10, maxConcurrency: 3 },
    )
    expect(result.valid).toBe(false)
  })

  test("extracts fenced plan JSON", () => {
    const plan = AgentClusterRuntime.extractPlanFromText(
      '```json\n{"goal":"Build","tasks":[{"id":"build","step":1,"title":"Build","role":"coder","complexity":"simple","model":"test/simple","dependencies":[],"prompt":"Build it","acceptanceCriteria":[],"expectedArtifacts":[]}]}\n```',
    )
    expect(plan?.tasks[0]?.id).toBe("build")
  })

  test("extracts a cancellation-only plan update", () => {
    const plan = AgentClusterRuntime.extractPlanFromText(
      '```json\n{"goal":"Remove obsolete work","tasks":[],"cancelTaskIDs":["obsolete-task"]}\n```',
    )
    expect(plan).toMatchObject({ goal: "Remove obsolete work", tasks: [], cancelTaskIDs: ["obsolete-task"] })
    expect(AgentClusterRuntime.validatePlan(plan!, { maxSubagents: 10, maxConcurrency: 3 }).valid).toBe(true)
  })

  test("normalizes image research to researcher", () => {
    const plan = AgentClusterRuntime.normalizePlan({
      goal: "Find a licensed image",
      tasks: [
        {
          id: "image-research",
          step: 1,
          title: "Find image sources",
          role: "image search",
          prompt: "Find a reusable image source",
          acceptanceCriteria: ["sources are verified"],
          expectedArtifacts: [],
        },
      ],
    })
    expect(plan?.tasks[0]?.role).toBe("researcher")
  })

  test("normalizes Office file work to office", () => {
    const plan = AgentClusterRuntime.normalizePlan({
      goal: "Update a workbook",
      tasks: [
        {
          id: "office-work",
          step: 1,
          title: "Update Excel workbook",
          role: "excel spreadsheet",
          prompt: "Update an XLSX workbook",
          acceptanceCriteria: ["formulas are verified"],
          expectedArtifacts: [],
        },
      ],
    })
    expect(plan?.tasks[0]?.role).toBe("office")
  })
})

describe("AgentCluster session task graph", () => {
  it.instance("starts an earlier planned task after a later user turn", () =>
    Effect.gen(function* () {
      const sessions = yield* Session.Service
      const chat = yield* sessions.create({ title: "Durable task graph" })
      yield* AgentCluster.persistPlan({
        sessionID: chat.id,
        plan: {
          goal: "First",
          tasks: [
            {
              id: "build-ui" as any,
              step: 1,
              title: "Build",
              role: "coder",
              complexity: "complex",
              model: "test/complex",
              dependencies: [],
              prompt: "Build the panel",
              acceptanceCriteria: [],
              expectedArtifacts: [],
            },
          ],
        },
      })
      yield* AgentCluster.persistPlan({
        sessionID: chat.id,
        plan: {
          goal: "Later",
          tasks: [
            {
              id: "document-ui" as any,
              step: 2,
              title: "Document",
              role: "writer",
              complexity: "simple",
              model: "test/simple",
              dependencies: [],
              prompt: "Document the panel",
              acceptanceCriteria: [],
              expectedArtifacts: [],
            },
          ],
        },
      })
      const dispatch = yield* AgentCluster.prepareTaskDispatch({
        sessionID: chat.id,
        requestedTaskID: "build-ui",
        prompt: "Start it",
        config: dispatchConfig,
      })
      const state = yield* AgentCluster.getSessionState(chat.id)
      expect(dispatch.taskID).toBe("build-ui")
      expect(state.tasks.map((item) => [item.id, item.step])).toEqual([
        ["build-ui", 1],
        ["document-ui", 2],
      ])
      expect(state).not.toHaveProperty("runs")
    }),
  )

  it.instance("preserves global step numbers across later plans", () =>
    Effect.gen(function* () {
      const chat = yield* (yield* Session.Service).create({ title: "Global step numbers" })
      const task = (id: string, step: number) => ({
        id: id as any,
        step,
        title: id,
        role: "coder" as const,
        complexity: "simple" as const,
        model: "test/simple",
        dependencies: [],
        prompt: id,
        acceptanceCriteria: [],
        expectedArtifacts: [],
      })
      yield* AgentCluster.persistPlan({ sessionID: chat.id, plan: { goal: "First", tasks: [task("step-five", 5)] } })
      yield* AgentCluster.persistPlan({ sessionID: chat.id, plan: { goal: "Later", tasks: [task("step-six", 6)] } })

      const state = yield* AgentCluster.getSessionState(chat.id)
      expect(state.tasks.map((item) => [item.id, item.step])).toEqual([
        ["step-five", 5],
        ["step-six", 6],
      ])
    }),
  )

  it.instance("updates and cancels unfinished tasks from a later plan", () =>
    Effect.gen(function* () {
      const chat = yield* (yield* Session.Service).create({ title: "Editable task graph" })
      const task = (id: string, step: number, prompt = id) => ({
        id: id as any,
        step,
        title: id,
        role: "coder" as const,
        complexity: "simple" as const,
        model: "test/simple",
        dependencies: [],
        prompt,
        acceptanceCriteria: ["complete"],
        expectedArtifacts: [],
      })
      yield* AgentCluster.persistPlan({
        sessionID: chat.id,
        plan: { goal: "First", tasks: [task("edit-me", 1), task("remove-me", 2)] },
      })
      yield* AgentCluster.persistPlan({
        sessionID: chat.id,
        plan: {
          goal: "Revised",
          tasks: [task("edit-me", 3, "Use the corrected implementation")],
          cancelTaskIDs: ["remove-me" as any],
        },
      })

      const state = yield* AgentCluster.getSessionState(chat.id)
      expect(state.tasks.find((item) => item.id === "edit-me")).toMatchObject({
        step: 3,
        prompt: "Use the corrected implementation",
        status: "planned",
      })
      expect(state.tasks.find((item) => item.id === "remove-me")).toMatchObject({ status: "cancelled" })
    }),
  )

  it.instance("updates single-agent plan task statuses through plan_update", () =>
    Effect.gen(function* () {
      const chat = yield* (yield* Session.Service).create({ title: "Single-agent plan status" })
      yield* AgentCluster.persistPlan({
        sessionID: chat.id,
        plan: {
          goal: "Write docs",
          tasks: [
            {
              id: "write-docs" as any,
              step: 1,
              title: "Write docs",
              role: "writer",
              complexity: "simple",
              model: "test/simple",
              dependencies: [],
              prompt: "Write the docs",
              acceptanceCriteria: ["docs exist"],
              expectedArtifacts: ["docs.md"],
            },
          ],
        },
      })

      yield* AgentCluster.updatePlanTaskStatus({ sessionID: chat.id, taskID: "write-docs", status: "running" })
      let state = yield* AgentCluster.getSessionState(chat.id)
      expect(state.tasks[0]).toMatchObject({ status: "running" })

      yield* AgentCluster.updatePlanTaskStatus({ sessionID: chat.id, taskID: "write-docs", status: "completed" })
      state = yield* AgentCluster.getSessionState(chat.id)
      expect(state.tasks[0]).toMatchObject({ status: "completed" })
      expect(yield* AgentCluster.sessionTaskStatus(chat.id)).toBe("completed")
    }),
  )

  it.instance("lets the primary deliberately restart a failed task out of step order", () =>
    Effect.gen(function* () {
      const chat = yield* (yield* Session.Service).create({ title: "Recover task graph" })
      const task = (id: string, step: number) => ({
        id: id as any,
        step,
        title: id,
        role: "coder" as const,
        complexity: "simple" as const,
        model: "test/simple",
        dependencies: [],
        prompt: id,
        acceptanceCriteria: [],
        expectedArtifacts: [],
      })
      yield* AgentCluster.persistPlan({
        sessionID: chat.id,
        plan: { goal: "Recover", tasks: [task("first", 1), task("later", 2)] },
      })
      const blocked = yield* AgentCluster.prepareTaskDispatch({
        sessionID: chat.id,
        requestedTaskID: "later",
        prompt: "Start later",
        config: dispatchConfig,
      }).pipe(Effect.exit)
      expect(blocked._tag).toBe("Failure")

      yield* Database.query((db) =>
        db
          .update(AgentClusterTaskTable)
          .set({ status: "failed" as const, review_issues: ["needs recovery"] })
          .where(
            Database.and(
              Database.eq(AgentClusterTaskTable.session_id, chat.id),
              Database.eq(AgentClusterTaskTable.id, "later" as any),
            ),
          )
          .run(),
      )
      const dispatch = yield* AgentCluster.prepareTaskDispatch({
        sessionID: chat.id,
        requestedTaskID: "later",
        allowOutOfOrder: true,
        prompt: "Restart later",
        config: dispatchConfig,
      })
      const state = yield* AgentCluster.getSessionState(chat.id)
      expect(dispatch.taskID).toBe("later")
      expect(state.tasks.find((item) => item.id === "later")).toMatchObject({
        status: "planned",
        review_issues: [],
        last_event: "restart requested",
      })
    }),
  )

  it.instance("keeps an accepted task immutable when a later plan reuses its id", () =>
    Effect.gen(function* () {
      const chat = yield* (yield* Session.Service).create({ title: "No duplicate ids" })
      const task = {
        id: "shared" as any,
        step: 1,
        title: "Original",
        role: "coder" as const,
        complexity: "simple" as const,
        model: "test/simple",
        dependencies: [],
        prompt: "Original work",
        acceptanceCriteria: [],
        expectedArtifacts: [],
      }
      yield* AgentCluster.persistPlan({ sessionID: chat.id, plan: { goal: "First", tasks: [task] } })
      yield* Database.query((db) =>
        db
          .update(AgentClusterTaskTable)
          .set({ status: "accepted" as const })
          .where(
            Database.and(
              Database.eq(AgentClusterTaskTable.session_id, chat.id),
              Database.eq(AgentClusterTaskTable.id, "shared" as any),
            ),
          )
          .run(),
      )
      const result = yield* AgentCluster.persistPlan({
        sessionID: chat.id,
        plan: { goal: "Second", tasks: [{ ...task, prompt: "Different work" }] },
      }).pipe(Effect.exit)
      expect(result._tag).toBe("Failure")
    }),
  )

  interruptIt.instance("interrupts an active worker before reassigning it", () =>
    Effect.gen(function* () {
      const sessions = yield* Session.Service
      const chat = yield* sessions.create({ title: "Reassign worker" })
      const task = (id: string) => ({
        id: id as any,
        step: 1,
        title: id,
        role: "coder" as const,
        complexity: "simple" as const,
        model: "test/simple",
        dependencies: [],
        prompt: id,
        acceptanceCriteria: [],
        expectedArtifacts: [],
      })
      yield* AgentCluster.persistPlan({
        sessionID: chat.id,
        plan: { goal: "Reuse", tasks: [task("old-work"), task("new-work")] },
      })
      yield* AgentCluster.markTaskRunning({
        sessionID: chat.id,
        taskID: "old-work",
        childSessionID: "ses_worker" as any,
      })
      const jobs = yield* BackgroundJob.Service
      yield* jobs.start({ id: "ses_worker", type: "task", run: Effect.never as Effect.Effect<string> })
      const result = yield* AgentCluster.interruptChildAssignment({
        sessionID: chat.id,
        taskID: "old-work" as any,
        reason: "Reassigned by cluster primary to new-work",
      })
      const dispatch = yield* AgentCluster.prepareTaskDispatch({
        sessionID: chat.id,
        requestedTaskID: "new-work",
        resumeSessionID: "ses_worker" as any,
        prompt: "Start new work",
        config: dispatchConfig,
      })
      const state = yield* AgentCluster.getSessionState(chat.id)
      expect(result.interrupted).toBe(true)
      expect(state.tasks.find((item) => item.id === "old-work")?.status).toBe("interrupted")
      expect((yield* jobs.get("ses_worker"))?.status).toBe("cancelled")
      expect(dispatch.childSessionID).toBe("ses_worker")
    }),
  )

  interruptIt.instance("also stops the child session runner before it is steered", () =>
    Effect.gen(function* () {
      const sessions = yield* Session.Service
      const chat = yield* sessions.create({ title: "Steer worker" })
      const task = {
        id: "worker-task" as any,
        step: 1,
        title: "Worker task",
        role: "coder" as const,
        complexity: "simple" as const,
        model: "test/simple",
        dependencies: [],
        prompt: "Keep working",
        acceptanceCriteria: [],
        expectedArtifacts: [],
      }
      yield* AgentCluster.persistPlan({ sessionID: chat.id, plan: { goal: "Steer", tasks: [task] } })
      yield* AgentCluster.markTaskRunning({
        sessionID: chat.id,
        taskID: task.id,
        childSessionID: "ses_worker" as any,
      })

      const started = yield* Deferred.make<void>()
      const stopped = yield* Deferred.make<void>()
      const runState = yield* SessionRunState.Service
      yield* runState
        .ensureRunning(
          "ses_worker" as any,
          Effect.succeed({} as never),
          Deferred.succeed(started, undefined).pipe(Effect.andThen(Effect.never)),
        )
        .pipe(Effect.asVoid, Effect.tap(() => Deferred.succeed(stopped, undefined).pipe(Effect.asVoid)), Effect.forkChild)
      yield* Deferred.await(started)

      const jobs = yield* BackgroundJob.Service
      yield* jobs.start({ id: "ses_worker", type: "task", run: Effect.never as Effect.Effect<string> })
      yield* AgentCluster.interruptActiveChildAssignment({
        sessionID: chat.id,
        childSessionID: "ses_worker" as any,
        reason: "Interrupted by a user steering message.",
      })

      yield* awaitWithTimeout(Deferred.await(stopped), "child session runner did not stop")
      yield* runState.assertNotBusy("ses_worker" as any)
    }),
  )
})
