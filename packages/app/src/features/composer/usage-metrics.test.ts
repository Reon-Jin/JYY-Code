import type { AssistantMessage, Session } from "@jyycode-ai/sdk/v2/client"
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

function assistant(id: string, tokens: AssistantMessage["tokens"]) {
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

  it("aggregates the root and all descendants without folding child tokens into main categories", () => {
    const root = session({
      cost: 0.25,
      tokens: { input: 100, output: 40, reasoning: 20, cache: { read: 10, write: 5 } },
    })
    const child = session({
      id: "ses_child",
      parentID: root.id,
      cost: 0.1,
      tokens: { input: 50, output: 20, reasoning: 5, cache: { read: 4, write: 1 } },
    })
    const grandchild = session({
      id: "ses_grandchild",
      parentID: child.id,
      cost: 0.05,
      tokens: { input: 10, output: 5, reasoning: 0, cache: { read: 0, write: 0 } },
    })
    const unrelated = session({ id: "ses_other", cost: 99, tokens: { input: 999, output: 0, reasoning: 0, cache: { read: 0, write: 0 } } })

    const usage = aggregateSessionUsage(root, [root, child, grandchild, unrelated])
    expect(usage.tokens).toEqual({
      input: 100,
      output: 40,
      reasoning: 20,
      other: 15,
      subagents: 95,
      total: 270,
    })
    expect(usage.cost).toBeCloseTo(0.4)
  })

  it("omits aggregate usage for a child session", () => {
    const child = session({ id: "ses_child", parentID: "ses_root" })
    const metrics = composerUsageMetrics({
      session: child,
      sessions: [child],
      messages: [assistant("msg_1", { input: 400, output: 50, reasoning: 25, cache: { read: 20, write: 5 } })],
      contextWindow: 10_000,
    })

    expect(metrics).toMatchObject({ contextWindow: 10_000, contextUsed: 500, contextPercent: 5 })
    expect(metrics.aggregate).toBeUndefined()
  })
})
