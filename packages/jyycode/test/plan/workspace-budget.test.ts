import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { describe, expect, it } from "bun:test"
import { PlanProtocol } from "../../src/plan/protocol"
import { PlanStore } from "../../src/plan/store"
import { ChildWorkspace } from "../../src/plan/child-workspace"
import { buildSnapshotManifest } from "../../src/plan/snapshot-manifest"
import { estimateSnapshotCost, preflightWorkspaceBudget, WorkspaceQuotaError } from "../../src/plan/workspace-budget"

function tempDirectory(prefix: string) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix))
}

describe("workspace snapshot budget", () => {
  it("estimates one shared baseline plus one writable copy per child", () => {
    const budget = estimateSnapshotCost({ manifest: { total_bytes: 100 }, taskCount: 3, currentBytes: 50 })
    expect(budget.baselineBytes).toBe(100)
    expect(budget.childBytes).toBe(100)
    expect(budget.estimatedNewBytes).toBe(400)
    expect(budget.projectedBytes).toBe(450)
  })

  it("rejects a quota before any workspace is created", async () => {
    const runtimeRoot = tempDirectory("jyycode-budget-runtime-")
    const root = tempDirectory("jyycode-budget-project-")
    fs.writeFileSync(path.join(root, "source.txt"), "source")
    const manifest = await buildSnapshotManifest({ root })
    await expect(
      preflightWorkspaceBudget({
        runtimeRoot,
        manifest,
        taskCount: 3,
        hardLimitBytes: 1,
      }),
    ).rejects.toBeInstanceOf(WorkspaceQuotaError)
    expect(fs.readdirSync(runtimeRoot)).toEqual([])
  })

  it("rejects snapshot dispatch before the durable task state changes", async () => {
    const root = tempDirectory("jyycode-budget-protocol-project-")
    const runtimeRoot = tempDirectory("jyycode-budget-protocol-runtime-")
    fs.writeFileSync(path.join(root, "source.txt"), "source")
    const protocol = new PlanProtocol({
      store: new PlanStore(),
      childWorkspace: new ChildWorkspace({
        project: { root, vcs: "none" },
        runtimeRoot,
        workspaceBudget: { hardLimitBytes: 1 },
      }),
      children: {
        async create() {
          throw new Error("child creation must not run")
        },
        async start() {},
        async terminate() {},
      },
    })
    const context = { workspaceRoot: root, sessionId: "ses_main", mode: "multi" as const }
    const created = await protocol.create(context, {
      title: "budget",
      goal: "budget",
      steps: [
        {
          title: "step",
          goal: "step",
          done_criteria: "done",
          tasks: [{ title: "task", goal: "task", done_criteria: "done", output_path: "out.txt" }],
        },
        { title: "next", goal: "next", done_criteria: "done" },
      ],
    })
    expect(created).toMatchObject({ ok: true })
    const result = await protocol.dispatch(context, { taskIds: ["s1_t1"], role: "general" })
    expect(result).toMatchObject({ ok: false, error: { code: "WORKSPACE_QUOTA_EXCEEDED" } })
    const plan = await protocol.read(context)
    expect(plan.ok && plan.plan?.steps[0]?.tasks[0]?.status).toBe("pending")
    expect(fs.readdirSync(runtimeRoot)).toEqual([])
  })
})
