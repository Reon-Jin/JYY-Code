import { describe, expect, it } from "bun:test"
import {
  defaultSubagentToolIDs,
  isReviewerReadOnlyShellCommand,
  isSubagentSelectableToolID,
  SUBAGENT_READ_ONLY_MCP_TOOL_ID,
} from "../../src/agent/subagent-tool-policy"
import { subagentRoleToolIDs } from "../../src/session/tools"

describe("subagent least-privilege policy", () => {
  it("uses restrictive role defaults when profile.tools is omitted", () => {
    const researcher = new Set(defaultSubagentToolIDs("researcher"))
    const planner = new Set(defaultSubagentToolIDs("Planner"))
    const implementer = new Set(defaultSubagentToolIDs("implementer"))
    const reviewer = new Set(defaultSubagentToolIDs("reviewer"))

    expect(researcher).toContain("webfetch")
    expect(researcher).toContain(SUBAGENT_READ_ONLY_MCP_TOOL_ID)
    expect(researcher).not.toContain("write")
    expect(researcher).not.toContain("bash")
    expect(planner).toEqual(new Set(["read", "glob", "grep", "context_read"]))
    expect(planner).not.toContain("edit")
    expect(implementer).toEqual(new Set(["read", "glob", "grep", "write", "edit", "bash"]))
    expect(reviewer).toContain("bash")
    expect(reviewer).not.toContain("write")
  })

  it("rejects wildcard and system-tool expansion while preserving exact opt-ins", () => {
    expect(isSubagentSelectableToolID("*")).toBe(false)
    expect(isSubagentSelectableToolID(SUBAGENT_READ_ONLY_MCP_TOOL_ID)).toBe(false)
    expect(isSubagentSelectableToolID("Plan.update")).toBe(false)
    expect(isSubagentSelectableToolID("mcp_server_read")).toBe(true)
    expect(
      subagentRoleToolIDs({ mode: "subagent", options: { subagentProfileID: "researcher" } } as never, {
        parentID: "parent" as never,
      }),
    ).toContain("Report")
  })

  it("keeps reviewer shell commands read-only and single-command", () => {
    expect(isReviewerReadOnlyShellCommand("git status --short")).toBe(true)
    expect(isReviewerReadOnlyShellCommand("rg TODO src")).toBe(true)
    expect(isReviewerReadOnlyShellCommand("git status; Remove-Item secret.txt")).toBe(false)
    expect(isReviewerReadOnlyShellCommand("npm test")).toBe(false)
    expect(isReviewerReadOnlyShellCommand("cat file > copy.txt")).toBe(false)
  })
})
