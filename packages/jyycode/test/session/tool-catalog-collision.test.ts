import { describe, expect, it } from "bun:test"
import { providerSafeToolName, resolveToolModelNames, type ToolIdentity } from "../../src/tool/registry"

describe("tool catalog identity resolution", () => {
  it("keeps builtin, plugin, MCP, and plan identities distinct", () => {
    const identities: ToolIdentity[] = [
      { source: "builtin", sourceID: "builtin:run", modelName: providerSafeToolName("run") },
      { source: "plugin", sourceID: "plugin:run", modelName: providerSafeToolName("run") },
      { source: "mcp", sourceID: "mcp:server\0run", modelName: providerSafeToolName("run") },
      { source: "plan", sourceID: "plan:run", modelName: providerSafeToolName("run") },
    ]

    const resolved = resolveToolModelNames(identities)
    expect(resolved.collisions).toHaveLength(1)
    expect(new Set(resolved.names.values()).size).toBe(identities.length)
    expect(resolved.collisions[0]?.sourceIDs).toEqual(["builtin:run", "mcp:server\0run", "plan:run", "plugin:run"])
  })

  it("resolves sanitized-name collisions independently of registration order", () => {
    const first: ToolIdentity[] = [
      { source: "mcp", sourceID: "mcp:a.b\0run", modelName: providerSafeToolName("a.b_run") },
      { source: "mcp", sourceID: "mcp:a/b\0run", modelName: providerSafeToolName("a/b_run") },
    ]
    const forward = resolveToolModelNames(first)
    const reverse = resolveToolModelNames([...first].reverse())

    expect(forward.collisions).toHaveLength(1)
    expect(Object.fromEntries(forward.names)).toEqual(Object.fromEntries(reverse.names))
    expect(new Set(forward.names.values()).size).toBe(2)
  })
})
