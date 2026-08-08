import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { describe, expect, it } from "bun:test"
import { ChildWorkspace } from "../../src/plan/child-workspace"
import { PlanProtocol } from "../../src/plan/protocol"
import { PlanRecovery } from "../../src/plan/recovery"
import { PlanInbox } from "../../src/plan/events"
import { readHardeningPlan, hardeningContext, hardeningPlanInput } from "./hardening-fixtures"

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "jyycode-recovery-"))
  const runtime = fs.mkdtempSync(path.join(os.tmpdir(), "jyycode-recovery-runtime-"))
  return {
    root,
    runtime,
    cleanup() {
      fs.rmSync(root, { recursive: true, force: true })
      fs.rmSync(runtime, { recursive: true, force: true })
    },
  }
}

describe("PlanRecovery", () => {
  it("rejects a reserved dispatch when no child can be resumed", async () => {
    const value = fixture()
    try {
      const protocol = new PlanProtocol({
        inbox: new PlanInbox(),
        childWorkspace: new ChildWorkspace({
          project: { root: value.root, vcs: "none" },
          runtimeRoot: value.runtime,
        }),
      })
      const root = hardeningContext(value.root)
      await protocol.create(root, hardeningPlanInput("out/result.md"))
      expect((await protocol.dispatch(root, { taskIds: ["s1_t1"], role: "general" })).ok).toBe(true)
      expect(readHardeningPlan(value.root).steps[0]?.tasks[0]?.dispatch?.lifecycle).toBe("reserved")

      const recovery = new PlanRecovery({ workspaceRoot: value.root, store: protocol.store, inbox: protocol.inbox })
      const result = await recovery.reconcilePlan("ses_main")
      expect(result.rejected).toEqual(["s1_t1"])
      expect(readHardeningPlan(value.root).steps[0]?.tasks[0]).toMatchObject({
        status: "rejected",
        dispatch: { lifecycle: "settled" },
      })
      expect(protocol.inbox.pending("ses_main")).toHaveLength(1)
    } finally {
      value.cleanup()
    }
  })

  it("continues a reserved dispatch through an injected resume callback", async () => {
    const value = fixture()
    try {
      const protocol = new PlanProtocol({
        childWorkspace: new ChildWorkspace({
          project: { root: value.root, vcs: "none" },
          runtimeRoot: value.runtime,
        }),
      })
      const root = hardeningContext(value.root)
      await protocol.create(root, hardeningPlanInput("out/result.md"))
      await protocol.dispatch(root, { taskIds: ["s1_t1"], role: "general" })
      const recovery = new PlanRecovery({
        workspaceRoot: value.root,
        store: protocol.store,
        resume: async ({ phase }) => ({ childSessionId: `recovered-${phase}`, started: true }),
      })
      const result = await recovery.reconcilePlan("ses_main")
      expect(result.continued).toEqual(["s1_t1"])
      expect(readHardeningPlan(value.root).steps[0]?.tasks[0]).toMatchObject({
        status: "running",
        dispatch: { lifecycle: "running", child_session_id: "recovered-reserved" },
      })
    } finally {
      value.cleanup()
    }
  })
})
