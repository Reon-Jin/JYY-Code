import { describe, expect, test } from "bun:test"
import { AgentCluster } from "../../src/agent-cluster/cluster"
import { ClusterPrimaryPrompt, runInstructions } from "../../src/agent-cluster/planner"
import { AgentClusterRuntime } from "../../src/agent-cluster/runtime"
import { ConfigAgentCluster } from "../../src/config/agent-cluster"
import type { Session } from "../../src/session/session"

describe("AgentCluster planner instructions", () => {
  test("describe dependency steps as parallel dispatch waves", () => {
    expect(ClusterPrimaryPrompt).toContain("A step is a dispatch wave")
    expect(ClusterPrimaryPrompt).toContain("step i must depend only on results from steps 1 through i-1")
    expect(ClusterPrimaryPrompt).toContain("Step 1 has no prior results")
    expect(ClusterPrimaryPrompt).toContain("multiple planned steps have no dependency path")
    expect(ClusterPrimaryPrompt).not.toContain("ANTI-PATTERN")
  })

  test("inject runtime scheduling rules and step metadata into the run instructions", () => {
    const text = runInstructions({
      runID: "run-1",
      artifactDir: "/tmp/artifacts",
      simpleModel: "provider/simple",
      complexModel: "provider/complex",
      visualModel: "provider/visual",
      reviewerModel: "provider/reviewer",
      maxSubagents: 100,
      maxConcurrency: 10,
      maxReviewRounds: 2,
    })

    expect(text).toContain("max_subagents: 100")
    expect(text).toContain("max_concurrency: 10")
    expect(text).toContain("Step 1 tasks have dependencies=[]")
    expect(text).toContain("tasks in the same step must not depend on each other")
    expect(text).toContain("A single dependency step must not exceed max_concurrency")
    expect(text).toContain('"step":1')
    expect(text).toContain("treat them as ready together")
    expect(text).toContain("Do not stop after presenting the plan")
    expect(text).toContain("visual_model: provider/visual")
    expect(text).toContain("PDF/PPT/DOCX layout")
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
  } satisfies Pick<Session.Info, "title" | "agent" | "path" | "multiAgent">

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

describe("AgentCluster.createRunID", () => {
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

describe("AgentClusterRuntime.validatePlan", () => {
  const task = (input: {
    id: string
    step: number
    dependencies?: string[]
    title?: string
  }) => ({
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

  test("accepts a dependency DAG with parallel ready work", () => {
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
      tasks: [
        task({ id: "research", step: 1 }),
        task({ id: "build", step: 2, dependencies: ["research"] }),
      ],
    }

    expect(
      AgentClusterRuntime.nextReadyBatch(plan, {
        completed: [],
        failed: ["research"],
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
