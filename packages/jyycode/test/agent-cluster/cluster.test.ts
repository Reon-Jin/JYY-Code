// @ts-nocheck -- legacy run-scoped cases are retained as skipped regression history.
import { describe, expect, test } from "bun:test"
import { AgentCluster } from "../../src/agent-cluster/cluster"
import {
  AgentClusterEventTable,
  AgentClusterRunTable,
  AgentClusterTaskTable,
} from "../../src/agent-cluster/cluster.sql"
import { Event as AgentClusterEvent } from "../../src/agent-cluster/event"
import { Bus } from "../../src/bus"
import type { Plan, RunID } from "../../src/agent-cluster/schema"
import { ClusterPrimaryPrompt, runInstructions } from "../../src/agent-cluster/planner"
import { RoleSkillDefinitions } from "../../src/agent-cluster/role-skills"
import { AgentClusterRuntime } from "../../src/agent-cluster/runtime"
import { ConfigAgentCluster } from "../../src/config/agent-cluster"
import { ModelID, ProviderID } from "../../src/provider/schema"
import * as Database from "../../src/storage/db"
import { Session } from "../../src/session/session"
import { MessageID } from "../../src/session/schema"
import type { Session as SessionInfo } from "../../src/session/session"
import { Effect, Layer } from "effect"
import { testEffect } from "../lib/effect"

const it = testEffect(Session.defaultLayer)
const eventIt = testEffect(Layer.mergeAll(Session.defaultLayer, Bus.defaultLayer))

describe("AgentCluster planner instructions", () => {
  test("describe dependency steps as parallel dispatch waves", () => {
    expect(ClusterPrimaryPrompt).toContain("A step is a dispatch wave")
    expect(ClusterPrimaryPrompt).toContain("step i must depend only on results from steps 1 through i-1")
    expect(ClusterPrimaryPrompt).toContain("Step 1 has no prior results")
    expect(ClusterPrimaryPrompt).toContain("Steps are strict gates")
    expect(ClusterPrimaryPrompt).toContain("agent_cluster_review")
    expect(ClusterPrimaryPrompt).toContain("ROLE CAPABILITY CATALOG")
    expect(ClusterPrimaryPrompt).toContain("chart:")
    expect(ClusterPrimaryPrompt).not.toContain(RoleSkillDefinitions.chart.skillName)
    expect(ClusterPrimaryPrompt).not.toContain("# Chart specialist skill")
    expect(ClusterPrimaryPrompt).not.toContain("ANTI-PATTERN")
  })

  test("inject runtime scheduling rules and step metadata into the run instructions", () => {
    const text = runInstructions({
      sessionID: "ses_root",
      artifactDir: "/tmp/artifacts",
      simpleModel: "provider/simple",
      complexModel: "provider/complex",
      visualModel: "provider/visual",
      maxSubagents: 100,
      maxConcurrency: 10,
      maxReviewRounds: 2,
      reusableSubagents: [
        {
          sessionID: "ses_researcher",
          lastTaskID: "task-research",
          role: "researcher",
          title: "Research",
          status: "accepted",
        },
      ],
    })

    expect(text).toContain("max_subagents: 100")
    expect(text).toContain("max_concurrency: 10")
    expect(text).toContain("Step 1 tasks have dependencies=[]")
    expect(text).toContain("tasks in the same step must not depend on each other")
    expect(text).toContain("A single dependency step must not exceed max_concurrency")
    expect(text).toContain('"step":1')
    expect(text).toContain("Dispatch only the smallest unfinished step")
    expect(text).toContain("agent_cluster_review")
    expect(text).toContain("Do not stop after presenting the JSON plan")
    expect(text).toContain("visual_model: provider/visual")
    expect(text).toContain("PDF/PPT/DOCX layout")
    expect(text).toContain("use provider/simple for simple tasks")
    expect(text).toContain("use provider/complex for complex tasks")
    expect(text).not.toContain("including simple and complex work")
    expect(text).toContain('set "model" to "-" so the runtime applies this routing')
    expect(text).toContain("reusable_subagents:")
    expect(text).toContain("ses_researcher")
    expect(text).toContain("resume_session_id=<existing ses_... id>")
    expect(text).toContain("This session task graph is durable")
    expect(text).toContain("Never recreate an existing task")
    expect(text).toContain("global Step numbers")
  })

  test("planner instructions require terminal task_status before final synthesis", () => {
    const text = runInstructions({
      sessionID: "ses_root",
      artifactDir: ".jyycode/agent-cluster",
      simpleModel: "p/m1",
      complexModel: "p/m2",
      visualModel: "p/m3",
      maxSubagents: 10,
      maxConcurrency: 3,
      maxReviewRounds: 2,
    })

    expect(text).toContain("Do not produce the final synthesis")
    expect(text).toContain("terminal task_status")
  })
})

describe("AgentCluster.isMailSession", () => {
  test("returns true for mail session title with Email: prefix", () => {
    expect(
      AgentCluster.isMailSession({
        title: "Email: Welcome to jyycode",
        agent: "build",
        path: undefined,
      }),
    ).toBe(true)
  })

  test("returns true for mail session title with Reply email: prefix", () => {
    expect(
      AgentCluster.isMailSession({
        title: "Reply email: Question about billing",
        agent: "build",
        path: undefined,
      }),
    ).toBe(true)
  })

  test("returns true when agent is 'mail'", () => {
    expect(
      AgentCluster.isMailSession({
        title: "Some normal title",
        agent: "mail",
        path: undefined,
      }),
    ).toBe(true)
  })

  test("returns true when path is 'mail'", () => {
    expect(
      AgentCluster.isMailSession({
        title: "Some normal title",
        agent: "build",
        path: "mail",
      }),
    ).toBe(true)
  })

  test("returns false for normal session", () => {
    expect(
      AgentCluster.isMailSession({
        title: "Help me write a function",
        agent: "build",
        path: undefined,
      }),
    ).toBe(false)
  })

  test("returns false for session with subagent", () => {
    expect(
      AgentCluster.isMailSession({
        title: "Build the login page",
        agent: "general",
        path: "subtask",
      }),
    ).toBe(false)
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

  test("returns false when config.enabled is false", () => {
    expect(
      AgentCluster.canUseAgentCluster({
        session: baseSession,
        config: { ...baseConfig, enabled: false },
      }),
    ).toBe(false)
  })

  test("returns false for mail session title", () => {
    expect(
      AgentCluster.canUseAgentCluster({
        session: { ...baseSession, title: "Email: Welcome" },
        config: baseConfig,
        requested: true,
      }),
    ).toBe(false)
  })

  test("returns false for mail agent", () => {
    expect(
      AgentCluster.canUseAgentCluster({
        session: { ...baseSession, agent: "mail" },
        config: baseConfig,
        requested: true,
      }),
    ).toBe(false)
  })

  test("returns false for mail path", () => {
    expect(
      AgentCluster.canUseAgentCluster({
        session: { ...baseSession, path: "mail" },
        config: baseConfig,
        requested: true,
      }),
    ).toBe(false)
  })

  test("returns false by default (default_on: false, no multiAgent, no requested)", () => {
    expect(
      AgentCluster.canUseAgentCluster({
        session: baseSession,
        config: baseConfig,
      }),
    ).toBe(false)
  })

  test("returns true when requested is true", () => {
    expect(
      AgentCluster.canUseAgentCluster({
        session: baseSession,
        config: baseConfig,
        requested: true,
      }),
    ).toBe(true)
  })

  test("returns true when session.multiAgent is true", () => {
    expect(
      AgentCluster.canUseAgentCluster({
        session: { ...baseSession, multiAgent: true },
        config: baseConfig,
      }),
    ).toBe(true)
  })

  test("returns true when config.default_on is true", () => {
    expect(
      AgentCluster.canUseAgentCluster({
        session: baseSession,
        config: { ...baseConfig, default_on: true },
      }),
    ).toBe(true)
  })

  test("returns false for subagent sessions even when default_on is true", () => {
    expect(
      AgentCluster.canUseAgentCluster({
        session: { ...baseSession, parentID: "ses_parent" as any },
        config: { ...baseConfig, default_on: true },
      }),
    ).toBe(false)
  })

  test("returns false when default_on is true but session.path is mail", () => {
    expect(
      AgentCluster.canUseAgentCluster({
        session: { ...baseSession, path: "mail" },
        config: { ...baseConfig, default_on: true },
      }),
    ).toBe(false)
  })

  test("returns false when default_on is true but session.agent is mail", () => {
    expect(
      AgentCluster.canUseAgentCluster({
        session: { ...baseSession, agent: "mail" },
        config: { ...baseConfig, default_on: true },
      }),
    ).toBe(false)
  })

  test("returns false when default_on is true but title is mail", () => {
    expect(
      AgentCluster.canUseAgentCluster({
        session: { ...baseSession, title: "Email: Welcome mail" },
        config: { ...baseConfig, default_on: true },
      }),
    ).toBe(false)
  })

  test("requested overrides multiAgent when true", () => {
    expect(
      AgentCluster.canUseAgentCluster({
        session: { ...baseSession, multiAgent: false },
        config: baseConfig,
        requested: true,
      }),
    ).toBe(true)
  })

  test("uses defaults when config is undefined (enabled=true by default)", () => {
    expect(
      AgentCluster.canUseAgentCluster({
        session: baseSession,
        config: undefined,
        requested: true,
      }),
    ).toBe(true)
  })
})

describe.skip("legacy AgentCluster.createRunID", () => {
  test("returns a non-empty string", () => {
    const id = AgentCluster.createRunID()
    expect(typeof id).toBe("string")
    expect(id.length).toBeGreaterThan(0)
  })

  test("returns unique values", () => {
    const ids = new Set(Array.from({ length: 10 }, () => AgentCluster.createRunID()))
    expect(ids.size).toBe(10)
  })
})

describe.skip("legacy run-scoped AgentCluster.persistPlan", () => {
  eventIt.instance("publishes every task state transition for live TUI refresh", () =>
    Effect.gen(function* () {
      const sessions = yield* Session.Service
      const bus = yield* Bus.Service
      const chat = yield* sessions.create({ title: "Live cluster steps" })
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
            goal: "Refresh steps",
            planner_model: "test/planner",
            reviewer_model: "test/reviewer",
            time_created: now,
            time_updated: now,
          })
          .run(),
      )

      const events: string[] = []
      let signal!: () => void
      const received = new Promise<void>((resolve) => (signal = resolve))
      const unsubscribe = yield* bus.subscribeCallback(AgentClusterEvent, (event) => {
        if (event.properties.type !== "task") return
        events.push(String(event.properties.status))
        if (events.length === 3) signal()
      })
      const plan: Plan = {
        goal: "Refresh steps",
        tasks: [
          {
            id: AgentClusterRuntime.coerceTaskID("live-task"),
            step: 1,
            title: "Live task",
            role: "general",
            complexity: "simple",
            model: "test/simple",
            dependencies: [],
            prompt: "Do work",
            acceptanceCriteria: ["done"],
            expectedArtifacts: [],
          },
        ],
      }

      yield* AgentCluster.persistPlan({ runID, plan })
      yield* AgentCluster.markTaskRunning({ runID, taskID: "live-task", childSessionID: "ses_child" as any })
      yield* AgentCluster.submitTaskResult({
        runID,
        taskID: "live-task",
        childSessionID: "ses_child" as any,
        summary: "done",
      })
      yield* Effect.promise(() => received).pipe(Effect.timeout("2 seconds"))
      unsubscribe()

      expect(events).toEqual(["planned", "running", "submitted"])
      const persisted = Database.use((db) =>
        db.select().from(AgentClusterEventTable).where(Database.eq(AgentClusterEventTable.run_id, runID)).all(),
      )
      expect(persisted.filter((event) => event.type === "task")).toHaveLength(3)
    }),
  )

  it.instance("scopes reusable plan task ids to each run", () =>
    Effect.gen(function* () {
      const sessions = yield* Session.Service
      const chat = yield* sessions.create({ title: "Repeated cluster runs" })
      const users = yield* Effect.all(
        [1, 2].map((index) =>
          sessions.updateMessage({
            id: MessageID.ascending(),
            role: "user" as const,
            sessionID: chat.id,
            agent: "cluster",
            model: { providerID: ProviderID.make("test"), modelID: ModelID.make("test") },
            time: { created: Date.now() + index },
          }),
        ),
      )
      const runIDs = [AgentCluster.createRunID() as RunID, AgentCluster.createRunID() as RunID]
      const now = Date.now()
      Database.use((db) => {
        for (const [index, runID] of runIDs.entries()) {
          db.insert(AgentClusterRunTable)
            .values({
              id: runID,
              session_id: chat.id,
              parent_message_id: users[index]!.id,
              enabled: true,
              status: "planning",
              goal: "Research",
              planner_model: "test/planner",
              reviewer_model: "test/planner",
              time_created: now,
              time_updated: now,
            })
            .run()
        }
      })
      const plan: Plan = {
        goal: "Research",
        tasks: [
          {
            id: AgentClusterRuntime.coerceTaskID("task-research"),
            step: 1,
            title: "Research",
            role: "researcher",
            complexity: "simple",
            model: "test/simple",
            dependencies: [],
            prompt: "Research",
            acceptanceCriteria: ["done"],
            expectedArtifacts: [],
          },
        ],
      }

      yield* AgentCluster.persistPlan({ runID: runIDs[0]!, plan })
      yield* AgentCluster.persistPlan({ runID: runIDs[1]!, plan })

      const rows = Database.use((db) =>
        db
          .select()
          .from(AgentClusterTaskTable)
          .where(Database.eq(AgentClusterTaskTable.id, "task-research" as any))
          .all(),
      )
      expect(rows.map((row) => row.run_id).toSorted()).toEqual(runIDs.toSorted())
    }),
  )

  it.instance("does not persist exact accepted tasks from earlier runs", () =>
    Effect.gen(function* () {
      const sessions = yield* Session.Service
      const chat = yield* sessions.create({ title: "Incremental cluster runs" })
      const users = yield* Effect.all(
        [1, 2].map((index) =>
          sessions.updateMessage({
            id: MessageID.ascending(),
            role: "user" as const,
            sessionID: chat.id,
            agent: "cluster",
            model: { providerID: ProviderID.make("test"), modelID: ModelID.make("test") },
            time: { created: Date.now() + index },
          }),
        ),
      )
      const previousRunID = AgentCluster.createRunID() as RunID
      const currentRunID = AgentCluster.createRunID() as RunID
      const now = Date.now()
      Database.use((db) => {
        for (const [index, runID] of [previousRunID, currentRunID].entries()) {
          db.insert(AgentClusterRunTable)
            .values({
              id: runID,
              session_id: chat.id,
              parent_message_id: users[index]!.id,
              enabled: true,
              status: index === 0 ? "completed" : "planning",
              goal: index === 0 ? "Create base files" : "Extend files",
              planner_model: "test/planner",
              reviewer_model: "test/planner",
              time_created: now + index,
              time_updated: now + index,
            })
            .run()
        }
        db.insert(AgentClusterTaskTable)
          .values({
            id: AgentClusterRuntime.coerceTaskID("task-create-1"),
            run_id: previousRunID,
            role: "general",
            title: "Create 1.txt",
            prompt: "Create 1.txt",
            complexity: "simple",
            model: "test/simple",
            status: "accepted",
            step: 1,
            dependencies: [],
            acceptance_criteria: ["created"],
            artifact_paths: ["1.txt"],
            time_created: now,
            time_updated: now,
          })
          .run()
      })

      const plan: Plan = {
        goal: "Extend files",
        tasks: [
          {
            id: AgentClusterRuntime.coerceTaskID("task-create-1"),
            step: 1,
            title: "Create 1.txt",
            role: "general",
            complexity: "simple",
            model: "test/simple",
            dependencies: [],
            prompt: "Create 1.txt",
            acceptanceCriteria: ["created"],
            expectedArtifacts: ["1.txt"],
          },
          {
            id: AgentClusterRuntime.coerceTaskID("task-create-4"),
            step: 2,
            title: "Create 4.txt",
            role: "general",
            complexity: "simple",
            model: "test/simple",
            dependencies: [AgentClusterRuntime.coerceTaskID("task-create-1")],
            prompt: "Create 4.txt",
            acceptanceCriteria: ["created"],
            expectedArtifacts: ["4.txt"],
          },
        ],
      }

      yield* AgentCluster.persistPlan({ runID: currentRunID, plan })
      const rows = Database.use((db) =>
        db.select().from(AgentClusterTaskTable).where(Database.eq(AgentClusterTaskTable.run_id, currentRunID)).all(),
      )

      expect(rows.map((row) => String(row.id))).toEqual(["task-create-4"])
      expect(rows[0]?.step).toBe(1)
      expect(rows[0]?.dependencies).toEqual([])
    }),
  )

  it.instance("inserts planned task rows", () =>
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
      const plan: Plan = {
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
            acceptanceCriteria: ["notes written"],
            expectedArtifacts: ["notes.md"],
          },
          {
            id: AgentClusterRuntime.coerceTaskID("build"),
            step: 2,
            title: "Build",
            role: "coder",
            complexity: "complex",
            model: "test/complex",
            dependencies: [AgentClusterRuntime.coerceTaskID("research")],
            prompt: "Build the feature",
            acceptanceCriteria: ["tests pass"],
            expectedArtifacts: ["patch"],
          },
        ],
      }

      yield* AgentCluster.persistPlan({ runID, plan })

      const rows = Database.use((db) =>
        db.select().from(AgentClusterTaskTable).where(Database.eq(AgentClusterTaskTable.run_id, runID)).all(),
      )
      expect(
        rows
          .map((row) => ({
            id: row.id,
            status: row.status,
            runID: row.run_id,
            step: row.step,
            dependencies: row.dependencies,
            result_summary: row.result_summary,
            review_issues: row.review_issues,
          }))
          .sort((a, b) => a.id.localeCompare(b.id)),
      ).toEqual([
        {
          id: AgentClusterRuntime.coerceTaskID("build"),
          status: "planned",
          runID,
          step: 2,
          dependencies: ["research"],
          result_summary: null,
          review_issues: [],
        },
        {
          id: AgentClusterRuntime.coerceTaskID("research"),
          status: "planned",
          runID,
          step: 1,
          dependencies: [],
          result_summary: null,
          review_issues: [],
        },
      ])
    }),
  )
})

describe.skip("legacy run-scoped AgentCluster.finalizeRunIfTerminal", () => {
  it.instance("keeps a resumed revision in revising state while the child runs", () =>
    Effect.gen(function* () {
      const sessions = yield* Session.Service
      const chat = yield* sessions.create({ title: "Cluster revision" })
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
        db.insert(AgentClusterRunTable)
          .values({
            id: runID,
            session_id: chat.id,
            parent_message_id: user.id,
            enabled: true,
            status: "reviewing",
            goal: "Fix feature",
            planner_model: "test/planner",
            reviewer_model: "test/reviewer",
            time_created: now,
            time_updated: now,
          })
          .run()
        db.insert(AgentClusterTaskTable)
          .values({
            id: AgentClusterRuntime.coerceTaskID("revise-task"),
            run_id: runID,
            role: "coder",
            title: "Revise",
            prompt: "Fix the rejected work",
            complexity: "simple",
            model: "test/simple",
            status: "revising",
            child_session_id: "ses_original" as any,
            acceptance_criteria: ["fixed"],
            artifact_paths: [],
            time_created: now,
            time_updated: now,
          })
          .run()
      })

      yield* AgentCluster.markTaskRunning({
        runID,
        taskID: "revise-task",
        childSessionID: "ses_original" as any,
      })

      const task = Database.use((db) =>
        db
          .select()
          .from(AgentClusterTaskTable)
          .where(Database.eq(AgentClusterTaskTable.id, "revise-task" as any))
          .get(),
      )
      expect(task?.status).toBe("revising")
    }),
  )

  it.instance("does not complete a run while tasks are running", () =>
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
      Database.use((db) => {
        const now = Date.now()
        db.insert(AgentClusterRunTable)
          .values({
            id: runID,
            session_id: chat.id,
            parent_message_id: user.id,
            enabled: true,
            status: "dispatching",
            goal: "Build feature",
            planner_model: "test/planner",
            reviewer_model: "test/reviewer",
            time_created: now,
            time_updated: now,
          })
          .run()
        db.insert(AgentClusterTaskTable)
          .values({
            id: AgentClusterRuntime.coerceTaskID("running-research"),
            run_id: runID,
            role: "researcher",
            title: "Research",
            prompt: "Research the feature",
            complexity: "simple",
            model: "test/simple",
            status: "running",
            acceptance_criteria: ["done"],
            artifact_paths: [],
            time_created: now,
            time_updated: now,
          })
          .run()
      })

      const completed = yield* AgentCluster.finalizeRunIfTerminal(runID)

      const row = Database.use((db) =>
        db.select().from(AgentClusterRunTable).where(Database.eq(AgentClusterRunTable.id, runID)).get(),
      )
      expect(completed).toBe(false)
      expect(row?.status).toBe("dispatching")
      expect(row?.completed_at).toBeNull()
    }),
  )

  it.instance("submitting a child result does not accept the task or complete the run", () =>
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
      Database.use((db) => {
        const now = Date.now()
        db.insert(AgentClusterRunTable)
          .values({
            id: runID,
            session_id: chat.id,
            parent_message_id: user.id,
            enabled: true,
            status: "dispatching",
            goal: "Build feature",
            planner_model: "test/planner",
            reviewer_model: "test/reviewer",
            time_created: now,
            time_updated: now,
          })
          .run()
        db.insert(AgentClusterTaskTable)
          .values({
            id: AgentClusterRuntime.coerceTaskID("submitted-task"),
            run_id: runID,
            role: "researcher",
            title: "Research",
            prompt: "Research the feature",
            complexity: "simple",
            model: "test/simple",
            status: "running",
            acceptance_criteria: ["done"],
            artifact_paths: [],
            time_created: now,
            time_updated: now,
          })
          .run()
      })

      yield* AgentCluster.submitTaskResult({
        runID,
        taskID: "submitted-task",
        childSessionID: "ses_child" as any,
        summary: "Evidence collected",
      })
      const state = yield* AgentCluster.finishRunFromTaskStates(runID)
      const task = Database.use((db) =>
        db
          .select()
          .from(AgentClusterTaskTable)
          .where(Database.eq(AgentClusterTaskTable.id, "submitted-task" as any))
          .get(),
      )
      const run = Database.use((db) =>
        db.select().from(AgentClusterRunTable).where(Database.eq(AgentClusterRunTable.id, runID)).get(),
      )

      expect(task?.status).toBe("submitted")
      expect(task?.result_summary).toBe("Evidence collected")
      expect(state).toBe("open")
      expect(run?.status).toBe("dispatching")
    }),
  )

  it.instance("marks a run failed when any task failed", () =>
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
      Database.use((db) => {
        const now = Date.now()
        db.insert(AgentClusterRunTable)
          .values({
            id: runID,
            session_id: chat.id,
            parent_message_id: user.id,
            enabled: true,
            status: "reviewing",
            goal: "Build feature",
            planner_model: "test/planner",
            reviewer_model: "test/reviewer",
            time_created: now,
            time_updated: now,
          })
          .run()
        db.insert(AgentClusterTaskTable)
          .values({
            id: AgentClusterRuntime.coerceTaskID("failed-task"),
            run_id: runID,
            role: "researcher",
            title: "Research",
            prompt: "Research the feature",
            complexity: "simple",
            model: "test/simple",
            status: "failed",
            acceptance_criteria: ["done"],
            artifact_paths: [],
            time_created: now,
            time_updated: now,
          })
          .run()
      })

      const state = yield* AgentCluster.finishRunFromTaskStates(runID)
      const run = Database.use((db) =>
        db.select().from(AgentClusterRunTable).where(Database.eq(AgentClusterRunTable.id, runID)).get(),
      )

      expect(state).toBe("failed")
      expect(run?.status).toBe("failed")
    }),
  )
})

describe("AgentClusterRuntime.validatePlan", () => {
  const task = (input: { id: string; step: number; dependencies?: string[]; title?: string }) => ({
    id: AgentClusterRuntime.coerceTaskID(input.id),
    step: input.step,
    title: input.title ?? input.id,
    role: "researcher" as const,
    complexity: "simple" as const,
    model: "provider/model",
    dependencies: (input.dependencies ?? []).map(AgentClusterRuntime.coerceTaskID),
    prompt: `Do ${input.id}`,
    acceptanceCriteria: ["done"],
    expectedArtifacts: [],
  })

  test("returns only the smallest unfinished step as ready work", () => {
    const plan = {
      goal: "ship feature",
      tasks: [
        task({ id: "research", step: 1 }),
        task({ id: "inspect", step: 1 }),
        task({ id: "build", step: 2, dependencies: ["research"] }),
      ],
    }

    expect(AgentClusterRuntime.validatePlan(plan, { maxSubagents: 10, maxConcurrency: 3 })).toEqual({
      valid: true,
      errors: [],
    })
    expect(
      AgentClusterRuntime.nextReadyBatch(plan, {
        completed: [],
      }).tasks.map((item) => String(item.id)),
    ).toEqual(["inspect", "research"])

    expect(
      AgentClusterRuntime.nextReadyBatch(plan, {
        completed: [AgentClusterRuntime.coerceTaskID("research")],
      }),
    ).toMatchObject({
      tasks: [{ id: AgentClusterRuntime.coerceTaskID("inspect") }],
      blocked: [{ reason: "waiting for earlier step 1" }],
    })
  })

  test("rejects duplicate expected artifacts within the same step", () => {
    const plan = {
      goal: "bad plan",
      tasks: [
        { ...task({ id: "api", step: 1 }), expectedArtifacts: ["shared.md"] },
        { ...task({ id: "ui", step: 1 }), expectedArtifacts: ["shared.md"] },
      ],
    }

    const result = AgentClusterRuntime.validatePlan(plan, { maxSubagents: 10, maxConcurrency: 3 })
    expect(result.valid).toBe(false)
    expect(result.errors.join("\n")).toContain("duplicate expected artifact shared.md")
  })

  test("reports step and synthesis gates from persisted task state", () => {
    const tasks = [
      { id: "research", step: 1, status: "accepted" as const },
      { id: "api", step: 1, status: "submitted" as const },
      { id: "test", step: 2, status: "planned" as const },
    ]

    expect(AgentClusterRuntime.stepGate(tasks, 2)).toEqual({
      allowed: false,
      pending: ["api"],
      rejected: [],
    })
    expect(AgentClusterRuntime.canSynthesize(tasks)).toBe(false)
    expect(AgentClusterRuntime.stepGate([{ id: "research", step: 1, status: "accepted" }], 2)).toEqual({
      allowed: true,
      pending: [],
      rejected: [],
    })
  })

  test("rejects duplicate ids, same-step dependencies, and over-wide steps", () => {
    const plan = {
      goal: "bad plan",
      tasks: [
        task({ id: "a", step: 1 }),
        task({ id: "a", step: 1, title: "duplicate" }),
        task({ id: "b", step: 1, dependencies: ["a"] }),
      ],
    }

    const result = AgentClusterRuntime.validatePlan(plan, { maxSubagents: 10, maxConcurrency: 2 })
    expect(result.valid).toBe(false)
    expect(result.errors.join("\n")).toContain("duplicate task id: a")
    expect(result.errors.join("\n")).toContain("dependencies must be in earlier steps")
    expect(result.errors.join("\n")).toContain("exceeding max_concurrency=2")
  })

  test("blocks ready tasks when dependencies are missing or failed", () => {
    const plan = {
      goal: "ship feature",
      tasks: [task({ id: "research", step: 1 }), task({ id: "build", step: 2, dependencies: ["research"] })],
    }

    expect(
      AgentClusterRuntime.nextReadyBatch(plan, {
        completed: [],
        failed: [AgentClusterRuntime.coerceTaskID("research")],
      }),
    ).toMatchObject({
      tasks: [],
      blocked: [{ reason: "dependency failed: research" }],
    })
  })

  test("enforces review round limit", () => {
    expect(AgentClusterRuntime.canRequestRevision({ roundsUsed: 1, limits: { maxReviewRounds: 2 } })).toBe(true)
    expect(AgentClusterRuntime.canRequestRevision({ roundsUsed: 2, limits: { maxReviewRounds: 2 } })).toBe(false)
  })
})

describe("AgentClusterRuntime.normalizePlan nested steps", () => {
  test("parses nested steps[].tasks[] format", () => {
    const json = {
      project: "Build website",
      steps: [
        {
          step: 1,
          tasks: [
            {
              id: "task-1",
              title: "Create HTML",
              role: "前端HTML开发",
              prompt: "Create index.html",
              acceptance_criteria: ["has DOCTYPE", "has h1"],
              expected_artifact: "index.html",
            },
            {
              id: "task-2",
              title: "Create CSS",
              role: "Coder Agent",
              prompt: "Create style.css",
              acceptanceCriteria: ["has body style"],
              expected_artifacts: ["style.css"],
            },
          ],
        },
        {
          step: 2,
          tasks: [
            {
              id: "task-3",
              title: "Test everything",
              role: "tester",
              prompt: "Run tests",
              acceptanceCriteria: ["all pass"],
              expectedArtifacts: [],
              dependencies: ["task-1", "task-2"],
            },
          ],
        },
      ],
    }

    const plan = AgentClusterRuntime.normalizePlan(json)
    expect(plan?.goal).toBe("Build website")
    expect(plan?.tasks.length).toBe(3)
    expect(plan?.tasks[0]?.id).toBe(AgentClusterRuntime.coerceTaskID("task-1"))
    expect(plan?.tasks[0]?.step).toBe(1)
    expect(plan?.tasks[0]?.role).toBe("coder") // "前端HTML开发" maps to coder
    expect(plan?.tasks[0]?.expectedArtifacts).toEqual(["index.html"])
    expect(plan?.tasks[0]?.acceptanceCriteria).toEqual(["has DOCTYPE", "has h1"])
    expect(plan?.tasks[1]?.role).toBe("coder") // "Coder Agent" maps to coder
    expect(plan?.tasks[1]?.expectedArtifacts).toEqual(["style.css"])
    expect(plan?.tasks[2]?.step).toBe(2)
    expect(plan?.tasks[2]?.role).toBe("tester")
    expect(plan?.tasks[2]?.dependencies).toEqual(["task-1", "task-2"].map(AgentClusterRuntime.coerceTaskID))
  })

  test("parses standard flat {goal, tasks} format unchanged", () => {
    const json = {
      goal: "Build report",
      tasks: [
        {
          id: "r1",
          step: 1,
          title: "Research",
          role: "researcher",
          prompt: "Do research",
          acceptanceCriteria: ["done"],
          expectedArtifacts: ["notes.md"],
        },
      ],
    }

    const plan = AgentClusterRuntime.normalizePlan(json)
    expect(plan?.goal).toBe("Build report")
    expect(plan?.tasks.length).toBe(1)
    expect(plan?.tasks[0]?.id).toBe(AgentClusterRuntime.coerceTaskID("r1"))
  })

  test("uses description as goal fallback", () => {
    const json = {
      description: "Create a simple tool",
      tasks: [
        {
          id: "t1",
          title: "Build",
          role: "coder",
          prompt: "Write code",
          acceptanceCriteria: ["works"],
        },
      ],
    }

    const plan = AgentClusterRuntime.normalizePlan(json)
    expect(plan?.goal).toBe("Create a simple tool")
    expect(plan?.tasks.length).toBe(1)
  })

  test("parses alternative field names: detailed_prompt, acceptance_criteria, expected_artifact_paths", () => {
    const json = {
      goal: "Build feature",
      tasks: [
        {
          id: "task-a",
          title: "Task A",
          role: "前端HTML开发",
          detailed_prompt: "Create HTML file",
          acceptance_criteria: ["file exists"],
          expected_artifact_paths: ["build/index.html"],
        },
      ],
    }

    const plan = AgentClusterRuntime.normalizePlan(json)
    expect(plan?.tasks[0]?.prompt).toBe("Create HTML file")
    expect(plan?.tasks[0]?.acceptanceCriteria).toEqual(["file exists"])
    expect(plan?.tasks[0]?.expectedArtifacts).toEqual(["build/index.html"])
    expect(plan?.tasks[0]?.role).toBe("coder") // 前端HTML开发 maps to coder
  })

  test("handles instruction as prompt fallback", () => {
    const json = {
      goal: "Test",
      tasks: [
        {
          id: "t1",
          title: "Do it",
          role: "general",
          instruction: "Write a test",
          acceptanceCriteria: ["works"],
        },
      ],
    }

    const plan = AgentClusterRuntime.normalizePlan(json)
    expect(plan?.tasks[0]?.prompt).toBe("Write a test")
  })
})

describe("AgentClusterRuntime.extractPlanFromText", () => {
  test("repairs unescaped quotes inside an LLM-generated task prompt", () => {
    const plan = AgentClusterRuntime.extractPlanFromText(`
\`\`\`json
{
  "goal": "Build an FPS HUD",
  "tasks": [
    {
      "id": "task-hud",
      "step": 1,
      "title": "Implement HUD",
      "role": "coder",
      "complexity": "simple",
      "model": "-",
      "dependencies": [],
      "prompt": "Show a "+100" floating label and a "WAVE 3" banner",
      "acceptanceCriteria": ["Both labels are visible"],
      "expectedArtifacts": ["js/ui.js"]
    }
  ]
}
\`\`\`
`)

    expect(plan?.tasks).toHaveLength(1)
    expect(plan?.tasks[0]?.id).toBe(AgentClusterRuntime.coerceTaskID("task-hud"))
    expect(plan?.tasks[0]?.prompt).toBe('Show a "+100" floating label and a "WAVE 3" banner')
  })
})

describe("AgentCluster session task graph", () => {
  it.instance("starts an earlier planned task after a later user turn", () =>
    Effect.gen(function* () {
      const sessions = yield* Session.Service
      const chat = yield* sessions.create({ title: "Durable task graph" })
      const initialPlan = {
        goal: "Build a durable panel",
        tasks: [
          {
            id: AgentClusterRuntime.coerceTaskID("build-ui"),
            step: 1,
            title: "Build UI",
            role: "coder" as const,
            complexity: "complex" as const,
            model: "test/complex",
            dependencies: [],
            prompt: "Build the initial panel",
            acceptanceCriteria: ["Panel exists"],
            expectedArtifacts: [],
          },
        ],
      }
      yield* AgentCluster.persistPlan({ sessionID: chat.id, plan: initialPlan })
      yield* AgentCluster.persistPlan({
        sessionID: chat.id,
        plan: {
          goal: "Add follow-up work",
          tasks: [
            {
              id: AgentClusterRuntime.coerceTaskID("document-ui"),
              step: 1,
              title: "Document UI",
              role: "writer" as const,
              complexity: "simple" as const,
              model: "test/simple",
              dependencies: [],
              prompt: "Document the panel",
              acceptanceCriteria: ["Documentation exists"],
              expectedArtifacts: [],
            },
          ],
        },
      })

      const dispatch = yield* AgentCluster.prepareTaskDispatch({
        sessionID: chat.id,
        requestedTaskID: "build-ui",
        prompt: "Start the earlier task",
        config: { simple_model: "test/simple", complex_model: "test/complex", visual_model: "test/visual" },
      })
      const state = yield* AgentCluster.getSessionState(chat.id)
      expect(dispatch.taskID).toBe("build-ui" as any)
      expect(state.tasks.map((task) => [task.id, task.step])).toEqual([
        ["build-ui", 1],
        ["document-ui", 2],
      ])
      expect(state).not.toHaveProperty("runs")
    }),
  )

  it.instance("rejects a distinct task that reuses an existing session task id", () =>
    Effect.gen(function* () {
      const sessions = yield* Session.Service
      const chat = yield* sessions.create({ title: "No duplicate task ids" })
      const task = {
        id: AgentClusterRuntime.coerceTaskID("shared-task"),
        step: 1,
        title: "Original task",
        role: "coder" as const,
        complexity: "simple" as const,
        model: "test/simple",
        dependencies: [],
        prompt: "Implement the original task",
        acceptanceCriteria: [],
        expectedArtifacts: [],
      }
      yield* AgentCluster.persistPlan({ sessionID: chat.id, plan: { goal: "First", tasks: [task] } })
      const result = yield* AgentCluster.persistPlan({
        sessionID: chat.id,
        plan: { goal: "Second", tasks: [{ ...task, title: "Different task", prompt: "Do something else" }] },
      }).pipe(Effect.exit)
      expect(result._tag).toBe("Failure")
    }),
  )
})
