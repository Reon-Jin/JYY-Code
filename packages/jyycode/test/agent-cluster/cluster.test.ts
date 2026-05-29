import { describe, expect, test } from "bun:test"
import { AgentCluster } from "../../src/agent-cluster/cluster"
import { ConfigAgentCluster } from "../../src/config/agent-cluster"
import type { Session } from "../../src/session/session"

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
