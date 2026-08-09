import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { describe, expect, it } from "bun:test"
import { ChildWorkspace } from "../../src/plan/child-workspace"
import { PlanProtocol } from "../../src/plan/protocol"
import { PlanRecovery } from "../../src/plan/recovery"
import { reconcilePlanOnce } from "../../src/plan/recovery"
import { PlanStore } from "../../src/plan/store"
import { PlanInbox } from "../../src/plan/events"
import { applyWorkspaceMerge } from "../../src/plan/workspace-merge"
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

  it("runs startup reconciliation once and does not duplicate Inbox recovery", async () => {
    const value = fixture()
    try {
      const protocol = new PlanProtocol({ inbox: new PlanInbox() })
      const root = hardeningContext(value.root)
      await protocol.create(root, hardeningPlanInput("out/result.md"))
      await protocol.dispatch(root, { taskIds: ["s1_t1"], role: "general" })
      const planPath = path.join(value.root, ".jyycode", "plan", "ses_main", "plan.json")
      const stored = JSON.parse(fs.readFileSync(planPath, "utf8"))
      stored.steps[0].tasks[0].status = "dispatched"
      stored.steps[0].tasks[0].dispatch.lifecycle = "reserved"
      fs.writeFileSync(planPath, JSON.stringify(stored, null, 2))

      const inbox = new PlanInbox()
      const options = { workspaceRoot: value.root, store: new PlanStore(), inbox }
      const first = reconcilePlanOnce("ses_main", options)
      const second = reconcilePlanOnce("ses_main", options)
      expect(second).toBe(first)
      await expect(first).resolves.toMatchObject({ rejected: ["s1_t1"] })
      await expect(second).resolves.toMatchObject({ rejected: ["s1_t1"] })
      expect(inbox.pending("ses_main")).toHaveLength(1)
    } finally {
      value.cleanup()
    }
  })

  it("resumes an interrupted merge journal after restart and cleans the recorded workspace", async () => {
    const value = fixture()
    let childRoot = ""
    let childOutput = ""
    try {
      const childWorkspace = new ChildWorkspace({ project: { root: value.root, vcs: "none" }, runtimeRoot: value.runtime })
      const protocol = new PlanProtocol({
        childWorkspace,
        children: {
          async create(input) {
            childRoot = path.dirname(path.dirname(input.brief.output_path))
            childOutput = input.brief.output_path
            return input.childSessionId
          },
          async start() {},
          async terminate() {},
        },
      })
      const root = hardeningContext(value.root)
      await protocol.create(root, hardeningPlanInput("out/result.md"))
      const dispatched = await protocol.dispatch(root, { taskIds: ["s1_t1"], role: "general" })
      expect(dispatched).toMatchObject({ ok: true })
      if (!dispatched.ok) return
      fs.mkdirSync(path.dirname(childOutput), { recursive: true })
      fs.writeFileSync(childOutput, "report\n")
      fs.mkdirSync(path.join(childRoot, "src"), { recursive: true })
      fs.writeFileSync(path.join(childRoot, "src", "a.ts"), "export const a = 1\n")
      fs.writeFileSync(path.join(childRoot, "src", "b.ts"), "export const b = 1\n")
      const runId = dispatched.dispatched[0]!.run_id
      await protocol.report(
        { workspaceRoot: childRoot, sessionId: "child_s1_t1", mode: "single", runId },
        { run_id: runId, status: "done", summary: "ready", artifacts: [childOutput], issues: [] },
      )
      const before = await protocol.read(root)
      if (!before.ok || !before.plan) return
      await protocol.update(root, {
        revision: before.plan.revision,
        ops: [{ op: "review_task", stepId: "s1", taskId: "s1_t1", decision: "approve" }],
      })
      const stored = readHardeningPlan(value.root)
      const workspace = stored.steps[0]!.tasks[0]!.dispatch!.workspace!
      const journalDirectory = path.join(value.runtime, "merge-restart-journal")
      expect(() =>
        applyWorkspaceMerge(
          {
            base: workspace.baseline_directory!,
            main: value.root,
            child: workspace.directory!,
            journal_directory: journalDirectory,
          },
          { interruptAfterWrites: 1 },
        ),
      ).toThrow("simulated interruption")
      const running = readHardeningPlan(value.root)
      const task = running.steps[0]!.tasks[0]!
      task.merge!.status = "running"
      task.merge!.cleanup = "pending"
      task.merge!.journal_directory = journalDirectory
      task.merge!.started_at = new Date().toISOString()
      fs.writeFileSync(path.join(value.root, ".jyycode", "plan", "ses_main", "plan.json"), JSON.stringify(running, null, 2))

      const restarted = new PlanRecovery({
        workspaceRoot: value.root,
        store: new PlanStore(),
        inbox: new PlanInbox(),
        childWorkspace: new ChildWorkspace({ project: { root: value.root, vcs: "none" }, runtimeRoot: value.runtime }),
      })
      const result = await restarted.reconcilePlan("ses_main")
      expect(result.settled).toEqual(["s1_t1"])
      expect(fs.readFileSync(path.join(value.root, "src", "a.ts"), "utf8")).toBe("export const a = 1\n")
      expect(fs.readFileSync(path.join(value.root, "src", "b.ts"), "utf8")).toBe("export const b = 1\n")
      expect(fs.existsSync(childRoot)).toBe(false)
      expect(readHardeningPlan(value.root).steps[0]?.tasks[0]?.merge).toMatchObject({ status: "merged", cleanup: "completed" })
    } finally {
      value.cleanup()
    }
  })

  it("preserves a recovered conflict and records it without deleting the child workspace", async () => {
    const value = fixture()
    let childRoot = ""
    let childOutput = ""
    try {
      fs.mkdirSync(path.join(value.root, "src"), { recursive: true })
      fs.writeFileSync(path.join(value.root, "src", "config.ts"), "base\n")
      const childWorkspace = new ChildWorkspace({ project: { root: value.root, vcs: "none" }, runtimeRoot: value.runtime })
      const inbox = new PlanInbox()
      const protocol = new PlanProtocol({
        inbox,
        childWorkspace,
        children: {
          async create(input) {
            childRoot = path.dirname(path.dirname(input.brief.output_path))
            childOutput = input.brief.output_path
            return input.childSessionId
          },
          async start() {},
          async terminate() {},
        },
      })
      const root = hardeningContext(value.root)
      await protocol.create(root, hardeningPlanInput("out/result.md"))
      const dispatched = await protocol.dispatch(root, { taskIds: ["s1_t1"], role: "general" })
      expect(dispatched).toMatchObject({ ok: true })
      if (!dispatched.ok) return
      fs.mkdirSync(path.dirname(childOutput), { recursive: true })
      fs.writeFileSync(childOutput, "report\n")
      fs.writeFileSync(path.join(childRoot, "src", "config.ts"), "child\n")
      fs.writeFileSync(path.join(value.root, "src", "config.ts"), "main\n")
      const runId = dispatched.dispatched[0]!.run_id
      await protocol.report(
        { workspaceRoot: childRoot, sessionId: "child_s1_t1", mode: "single", runId },
        { run_id: runId, status: "done", summary: "ready", artifacts: [childOutput], issues: [] },
      )
      const before = await protocol.read(root)
      if (!before.ok || !before.plan) return
      await protocol.update(root, {
        revision: before.plan.revision,
        ops: [{ op: "review_task", stepId: "s1", taskId: "s1_t1", decision: "approve" }],
      })
      const stored = readHardeningPlan(value.root)
      const task = stored.steps[0]!.tasks[0]!
      task.merge!.status = "running"
      task.merge!.cleanup = "pending"
      task.merge!.journal_directory = path.join(value.runtime, "merge-conflict-journal")
      task.merge!.started_at = new Date().toISOString()
      fs.writeFileSync(path.join(value.root, ".jyycode", "plan", "ses_main", "plan.json"), JSON.stringify(stored, null, 2))

      const restarted = new PlanRecovery({ workspaceRoot: value.root, store: new PlanStore(), inbox, childWorkspace })
      const result = await restarted.reconcilePlan("ses_main")
      expect(result.continued).toEqual(["s1_t1"])
      expect(readHardeningPlan(value.root).steps[0]?.tasks[0]?.merge).toMatchObject({ status: "conflict", cleanup: "not_started" })
      expect(fs.readFileSync(path.join(value.root, "src", "config.ts"), "utf8")).toBe("main\n")
      expect(fs.existsSync(childRoot)).toBe(true)
      expect(inbox.pending("ses_main")).toHaveLength(1)
      expect(inbox.pending("ses_main")[0]).toMatchObject({ kind: "merge_conflict", task_id: "s1_t1" })
    } finally {
      value.cleanup()
    }
  })
})
