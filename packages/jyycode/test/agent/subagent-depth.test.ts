import { describe, expect, it } from "bun:test"
import {
  assertCanSpawnSubagent,
  collectParentChain,
  computeAgentDepth,
  DEFAULT_HARD_MAX_AGENT_DEPTH,
  effectiveAgentDepthLimit,
  SubagentDepthError,
} from "../../src/agent/subagent-depth"
import { deriveSubagentSessionPermission } from "../../src/agent/subagent-permissions"
import { Permission } from "../../src/permission"

function graph(nodes: Array<{ id: string; parentID?: string; agentDepth?: number }>) {
  const values = new Map(nodes.map((node) => [node.id, node]))
  return (id: string) => values.get(id)
}

describe("subagent depth invariant", () => {
  it("keeps the hard cap authoritative over a future soft limit", () => {
    expect(DEFAULT_HARD_MAX_AGENT_DEPTH).toBe(1)
    expect(effectiveAgentDepthLimit()).toBe(1)
    expect(effectiveAgentDepthLimit(3)).toBe(1)
    expect(effectiveAgentDepthLimit(100)).toBe(1)
    expect(assertCanSpawnSubagent(0, 3)).toBe(1)
    expect(() => assertCanSpawnSubagent(1, 3)).toThrow(SubagentDepthError)
  })

  it("computes root and child depth from persisted ancestry", () => {
    const lookup = graph([
      { id: "root", agentDepth: 0 },
      { id: "child", parentID: "root", agentDepth: 1 },
    ])

    expect(computeAgentDepth({ sessionID: "new-root", lookup })).toBe(0)
    expect(computeAgentDepth({ sessionID: "new-child", parentID: "root", lookup })).toBe(1)
    expect(() => computeAgentDepth({ sessionID: "grandchild", parentID: "child", lookup })).toThrow(
      "exceeds hard limit",
    )
  })

  it("rejects missing parents and cycles before creation", () => {
    expect(() =>
      collectParentChain({
        sessionID: "new-child",
        parentID: "missing",
        lookup: graph([]),
      }),
    ).toThrow("parent session not found")

    const lookup = graph([
      { id: "a", parentID: "b", agentDepth: 1 },
      { id: "b", parentID: "a", agentDepth: 1 },
    ])
    expect(() => computeAgentDepth({ sessionID: "new", parentID: "a", lookup })).toThrow("parent cycle")
  })

  it("preserves task denial when a profile would otherwise allow task", () => {
    const subagent = {
      name: "general",
      mode: "subagent" as const,
      permission: Permission.fromConfig({ task: "allow" }),
      options: {},
    }
    const inherited = deriveSubagentSessionPermission({
      parentSessionPermission: [],
      parentAgent: undefined,
      subagent,
      parentAgentDepth: 1,
    })
    expect(Permission.evaluate("task", "general", Permission.merge(subagent.permission, inherited)).action).toBe("deny")
  })
})
