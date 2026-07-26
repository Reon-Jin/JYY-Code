// @ts-nocheck -- runtime assertions cover branded API boundaries directly.
import { describe, expect, test } from "bun:test"
import { Deferred, Effect, Layer } from "effect"
import { AgentCluster } from "../../src/agent-cluster/cluster"
import { BackgroundJob } from "../../src/background/job"
import { ConfigAgentCluster } from "../../src/config/agent-cluster"
import { ClusterPrimaryPrompt, runInstructions } from "../../src/agent-cluster/planner"
import { RoleSkillDefinitions } from "../../src/agent-cluster/role-skills"
import { AgentClusterRuntime } from "../../src/agent-cluster/runtime"
import { Session } from "../../src/session/session"
import type { Session as SessionInfo } from "../../src/session/session"
import { SessionRunState } from "../../src/session/run-state"
import { SessionStatus } from "../../src/session/status"
import { awaitWithTimeout, testEffect } from "../lib/effect"

const it = testEffect(Session.defaultLayer)
const backgroundLayer = BackgroundJob.defaultLayer
const runStateLayer = SessionRunState.layer.pipe(
  Layer.provide(Layer.mergeAll(backgroundLayer, SessionStatus.defaultLayer)),
)
const interruptIt = testEffect(Layer.mergeAll(Session.defaultLayer, backgroundLayer, runStateLayer))
const dispatchConfig = { simple_model: "test/simple", complex_model: "test/complex", visual_model: "test/visual" }

describe("AgentCluster planner instructions", () => {
  test("describe dependency steps as durable dispatch waves", () => {
    expect(ClusterPrimaryPrompt).toContain("A step is a dispatch wave")
    expect(ClusterPrimaryPrompt).toContain("Step 1 has no prior results")
    expect(ClusterPrimaryPrompt).toContain("agent_cluster_review")
    expect(ClusterPrimaryPrompt).toContain("ROLE CAPABILITY CATALOG")
    expect(ClusterPrimaryPrompt).not.toContain(RoleSkillDefinitions.chart.skillName)
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
    })
    expect(text).toContain("Dispatch only the smallest unfinished step")
    expect(text).toContain("This session task graph is durable")
    expect(text).toContain("Never recreate an existing task")
    expect(text).toContain("global Step numbers")
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

  test("respects config and excludes child and mail sessions", () => {
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
    expect(
      AgentCluster.canUseAgentCluster({
        session: { ...baseSession, title: "Email: welcome" },
        config: baseConfig,
        requested: true,
      }),
    ).toBe(false)
    expect(AgentCluster.canUseAgentCluster({ session: baseSession, config: baseConfig, requested: true })).toBe(true)
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
              step: 1,
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

  it.instance("rejects a changed duplicate task id within the session", () =>
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
