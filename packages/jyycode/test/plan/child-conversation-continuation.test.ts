import fs from "node:fs"
import path from "node:path"
import { describe, expect, it } from "bun:test"
import { tmpdir } from "../fixture/fixture"
import { ChildWorkspace } from "../../src/plan/child-workspace"
import { PlanProtocol, type ChildStartInput } from "../../src/plan/protocol"
import { PlanStore } from "../../src/plan/store"
import { hardeningPlanInput } from "./hardening-fixtures"

describe("child conversation continuation", () => {
  for (const status of ["reported", "approved"] as const) {
    it(`continues a reopened ${status} task in the original child session`, async () => {
      await using project = await tmpdir()
      await using runtime = await tmpdir()
      const created: ChildStartInput[] = []
      const resumed: ChildStartInput[] = []
      const protocol = new PlanProtocol({
        store: new PlanStore(),
        childWorkspace: new ChildWorkspace({ project: { root: project.path, vcs: "none" }, runtimeRoot: runtime.path }),
        children: {
          async create(input) {
            created.push(input)
            return input.childSessionId
          },
          async start() {},
          async resume(input) {
            resumed.push(input)
          },
          async terminate() {
            throw new Error("A follow-up must not terminate its original session")
          },
        },
      })
      const ctx = { workspaceRoot: project.path, sessionId: "ses_main", mode: "multi" as const }
      await protocol.create(ctx, hardeningPlanInput("notes.md"))
      expect(await protocol.dispatch(ctx, { taskIds: ["s1_t1"], role: "general" })).toMatchObject({ ok: true })
      const initial = created[0]!
      fs.writeFileSync(initial.brief.output_path, "original notes")
      expect(
        await protocol.report(
          {
            workspaceRoot: initial.brief.workspace_root,
            sessionId: initial.childSessionId,
            mode: "single",
            runId: initial.brief.run_id,
          },
          {
            run_id: initial.brief.run_id,
            status: "done",
            summary: "First draft",
            artifacts: [initial.brief.output_path],
            issues: [],
          },
        ),
      ).toMatchObject({ ok: true })
      let read = await protocol.read(ctx)
      if (!read.ok || !read.plan) throw new Error("Plan missing")
      if (status === "approved") {
        await protocol.update(ctx, {
          revision: read.plan.revision,
          ops: [{ op: "review_task", stepId: "s1", taskId: "s1_t1", decision: "approve" }],
        })
        read = await protocol.read(ctx)
        if (!read.ok || !read.plan) throw new Error("Plan missing")
      }
      expect(
        await protocol.update(ctx, {
          revision: read.plan.revision,
          ops: [{ op: "reopen_task", stepId: "s1", taskId: "s1_t1", reason: "Add one example." }],
        }),
      ).toMatchObject({ ok: true })
      expect(await protocol.dispatch(ctx, { taskIds: ["s1_t1"], role: "general" })).toMatchObject({
        ok: true,
        dispatched: [{ child_session_id: initial.childSessionId }],
      })
      expect(created).toHaveLength(1)
      expect(resumed).toHaveLength(1)
      expect(resumed[0]?.brief.workspace_root).toBe(initial.brief.workspace_root)
      expect(resumed[0]?.brief.previous_feedback?.review_feedback).toBe("Add one example.")
      expect(fs.readFileSync(initial.brief.output_path, "utf8")).toBe("original notes")
    })
  }

  it("preserves the conversation and workspace if its controller cannot resume", async () => {
    await using project = await tmpdir()
    await using runtime = await tmpdir()
    const created: ChildStartInput[] = []
    const protocol = new PlanProtocol({
      store: new PlanStore(),
      childWorkspace: new ChildWorkspace({ project: { root: project.path, vcs: "none" }, runtimeRoot: runtime.path }),
      children: {
        async create(input) {
          created.push(input)
          return input.childSessionId
        },
        async start() {},
        async terminate() {
          throw new Error("Do not delete a conversation when resume is unavailable")
        },
      },
    })
    const ctx = { workspaceRoot: project.path, sessionId: "ses_main", mode: "multi" as const }
    await protocol.create(ctx, hardeningPlanInput("notes.md"))
    await protocol.dispatch(ctx, { taskIds: ["s1_t1"], role: "general" })
    const initial = created[0]!
    fs.writeFileSync(initial.brief.output_path, "original notes")
    await protocol.report(
      {
        workspaceRoot: initial.brief.workspace_root,
        sessionId: initial.childSessionId,
        mode: "single",
        runId: initial.brief.run_id,
      },
      {
        run_id: initial.brief.run_id,
        status: "done",
        summary: "First draft",
        artifacts: [initial.brief.output_path],
        issues: [],
      },
    )
    const before = await protocol.read(ctx)
    if (!before.ok || !before.plan) throw new Error("Plan missing")
    expect(
      await protocol.update(ctx, {
        revision: before.plan.revision,
        ops: [{ op: "review_task", stepId: "s1", taskId: "s1_t1", decision: "reject", feedback: "Add one example." }],
      }),
    ).toMatchObject({ ok: true, auto_retry_failed: [{ taskIds: ["s1_t1"] }] })
    expect(await protocol.dispatch(ctx, { taskIds: ["s1_t1"], role: "general" })).toMatchObject({
      ok: false,
      error: { code: "DISPATCH_UNAVAILABLE" },
    })
    const after = await protocol.read(ctx)
    if (!after.ok || !after.plan) throw new Error("Plan missing")
    expect(after.plan.steps[0].tasks[0]).toMatchObject({
      status: "rejected",
      dispatch: { child_session_id: initial.childSessionId, run_id: initial.brief.run_id },
    })
    expect(created).toHaveLength(1)
    expect(fs.readFileSync(initial.brief.output_path, "utf8")).toBe("original notes")
  })
})
