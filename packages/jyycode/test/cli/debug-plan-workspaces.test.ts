import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { describe, expect, it } from "bun:test"
import { formatPlanWorkspaceReport } from "../../src/cli/cmd/debug/plan-workspaces"
import { inspectWorkspaceStorage } from "../../src/plan/workspace-sweeper"

function tempDirectory(prefix: string) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix))
}

describe("debug plan-workspaces CLI formatting", () => {
  it("redacts absolute workspace paths unless explicitly requested", async () => {
    const runtimeRoot = tempDirectory("jyycode-cli-plan-workspaces-")
    const workspace = path.join(runtimeRoot, "unknown-workspace")
    fs.mkdirSync(workspace)
    const report = await inspectWorkspaceStorage({ runtimeRoot })
    const safe = formatPlanWorkspaceReport(report, false)
    const visible = formatPlanWorkspaceReport(report, true)
    expect(JSON.stringify(safe)).not.toContain(runtimeRoot)
    expect(safe.items[0]?.directory).toBeUndefined()
    expect(visible.items[0]?.directory).toBe(workspace)
  })
})
