import type { AssistantMessage, Part, Session } from "@jyycode-ai/sdk/v2/client"
import { describe, expect, it } from "vitest"
import { aggregateSessionUsage, composerUsageMetrics, currentContextTokens } from "./usage-metrics"

const directory = "C:\\work\\demo"

function session(overrides: Partial<Session> = {}): Session {
  return {
    id: "ses_root",
    slug: "root",
    projectID: "project_1",
    directory,
    title: "Root",
    version: "test",
    time: { created: 1, updated: 1 },
    ...overrides,
  }
}

function assistant(id: string, tokens: AssistantMessage["tokens"]): { info: AssistantMessage; parts: Part[] } {
  const info: AssistantMessage = {
    id,
    sessionID: "ses_root",
    role: "assistant",
    time: { created: 1 },
    parentID: "msg_user",
    modelID: "gpt-5",
    providerID: "openai",
    mode: "build",
    agent: "build",
    path: { cwd: directory, root: directory },
    cost: 0,
    tokens,
  }
  return { info, parts: [] }
}

describe("usage metrics", () => {
  it("uses the latest non-empty assistant response for current context", () => {
    const messages = [
      assistant("msg_1", { input: 100, output: 20, reasoning: 10, cache: { read: 5, write: 2 } }),
      assistant("msg_2", { input: 600, output: 80, reasoning: 40, cache: { read: 30, write: 10 } }),
    ]

    expect(currentContextTokens(messages)).toBe(760)
  })

  it("reports the current root's durable usage", () => {
    const root = session({
      cost: 0.25,
      tokens: { input: 100, output: 40, reasoning: 20, cache: { read: 10, write: 5 } },
    })
    const usage = aggregateSessionUsage(root)
    expect(usage.tokens).toEqual({
      input: 100,
      output: 40,
      reasoning: 20,
      cache: 15,
      total: 175,
    })
    expect(usage.cost).toBeCloseTo(0.25)

    const metrics = composerUsageMetrics({
      session: root,
      messages: [],
    })
    expect(metrics.aggregate).toEqual(usage)
  })

  it("uses billed message usage while an older session's durable totals are still zero", () => {
    const root = session({
      cost: 0,
      tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    })
    const current = assistant("msg_billed", {
      input: 900,
      output: 20,
      reasoning: 0,
      cache: { read: 100, write: 0 },
    })
    current.info.usage = {
      version: 1,
      context: current.info.tokens,
      billing: { input: 120, output: 20, reasoning: 5, cache: { read: 30, write: 0 } },
      cost: 0.03,
    }
    const legacy = assistant("msg_legacy", {
      input: 2_000,
      output: 30,
      reasoning: 0,
      cache: { read: 0, write: 0 },
    })
    legacy.parts.push({
      id: "part_legacy_step",
      sessionID: root.id,
      messageID: legacy.info.id,
      type: "step-finish",
      reason: "stop",
      cost: 0.02,
      tokens: { input: 40, output: 10, reasoning: 0, cache: { read: 0, write: 0 } },
    })

    expect(aggregateSessionUsage(root, [current, legacy])).toEqual({
      tokens: { input: 160, output: 30, reasoning: 5, cache: 30, total: 225 },
      cost: 0.05,
    })
  })

  it("does not sum context snapshots when billed usage is unavailable", () => {
    const root = session({
      cost: 0,
      tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    })
    const contextOnly = assistant("msg_context", {
      input: 5_000,
      output: 500,
      reasoning: 0,
      cache: { read: 0, write: 0 },
    })

    expect(aggregateSessionUsage(root, [contextOnly]).tokens.total).toBe(0)
  })

  it("uses more complete billed messages while a nonzero session row is stale", () => {
    const root = session({
      cost: 0.01,
      tokens: { input: 100, output: 10, reasoning: 0, cache: { read: 0, write: 0 } },
    })
    const message = assistant("msg_billed", {
      input: 1_000,
      output: 20,
      reasoning: 0,
      cache: { read: 0, write: 0 },
    })
    message.info.usage = {
      version: 1,
      context: message.info.tokens,
      billing: { input: 200, output: 20, reasoning: 0, cache: { read: 0, write: 0 } },
      cost: 0.02,
    }

    expect(aggregateSessionUsage(root, [message])).toEqual({
      tokens: { input: 200, output: 20, reasoning: 0, cache: 0, total: 220 },
      cost: 0.02,
    })
  })

  it("omits aggregate usage for a child session", () => {
    const child = session({ id: "ses_child", parentID: "ses_root" })
    const metrics = composerUsageMetrics({
      session: child,
      messages: [assistant("msg_1", { input: 400, output: 50, reasoning: 25, cache: { read: 20, write: 5 } })],
      contextWindow: 10_000,
    })

    expect(metrics).toMatchObject({ contextWindow: 10_000, contextUsed: 500, contextPercent: 5 })
    expect(metrics.aggregate).toBeUndefined()
  })
})
