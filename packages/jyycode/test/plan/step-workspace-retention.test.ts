import fs from "node:fs"
import path from "node:path"
import { describe, expect, it } from "bun:test"
import { tmpdir } from "../fixture/fixture"
import { ChildWorkspace } from "../../src/plan/child-workspace"
import { PlanEventHub, PlanInbox, WakeupQueue } from "../../src/plan/events"
import { PlanProtocol, type ChildStartInput } from "../../src/plan/protocol"
import { PlanRecovery } from "../../src/plan/recovery"
import { planFilePath } from "../../src/plan/schema"
import { PlanStore } from "../../src/plan/store"
import { collectPlanReferences } from "../../src/plan/workspace-sweeper"

async function setup(root: string, runtimeRoot: string) {
  const starts = new Map<string, ChildStartInput>()
  const stopped: string[] = []
  const children = {
    async create(input: ChildStartInput) {
      starts.set(input.taskId, input)
      return input.childSessionId
    },
    async start() {},
    async terminate(sessionId: string) {
      stopped.push(sessionId)
    },
  }
  const childWorkspace = new ChildWorkspace({ project: { root, vcs: "none" }, runtimeRoot })
  const protocol = new PlanProtocol({
    store: new PlanStore(),
    events: new PlanEventHub(),
    inbox: new PlanInbox(),
    wakeups: new WakeupQueue(),
    children,
    childWorkspace,
  })
  const ctx = { workspaceRoot: root, sessionId: "ses_main", mode: "multi" as const }
  expect(
    await protocol.create(ctx, {
      goal: "Parallel collaboration",
      steps: [
        {
          goal: "Create artifacts",
          done_criteria: "All artifacts merged",
          tasks: ["early", "slow"].map((name) => ({
            goal: `Create ${name}`,
            done_criteria: `${name}.md exists`,
            output_path: `${name}.md`,
          })),
        },
        { goal: "Verify", done_criteria: "Verification complete" },
      ],
    }),
  ).toMatchObject({ ok: true })
  expect(await protocol.dispatch(ctx, { taskIds: ["s1_t1", "s1_t2"], role: "general" })).toMatchObject({ ok: true })
  const read = async () => {
    const value = await protocol.read(ctx)
    if (!value.ok || !value.plan) throw new Error("Plan missing")
    return value.plan
  }
  const approve = async (taskId: string) => {
    const input = starts.get(taskId)!
    fs.writeFileSync(input.brief.output_path, `Artifact ${taskId}`)
    expect(
      await protocol.report(
        {
          workspaceRoot: input.brief.workspace_root,
          sessionId: input.childSessionId,
          mode: "single",
          runId: input.brief.run_id,
        },
        {
          run_id: input.brief.run_id,
          status: "done",
          summary: "Ready",
          artifacts: [input.brief.output_path],
          issues: [],
        },
      ),
    ).toMatchObject({ ok: true, review: "pending_review" })
    expect(
      await protocol.update(ctx, {
        revision: (await read()).revision,
        ops: [{ op: "review_task", stepId: "s1", taskId, decision: "approve" }],
      }),
    ).toMatchObject({ ok: true })
  }
  return { protocol, ctx, starts, stopped, childWorkspace, children, read, approve }
}

describe("Step workspace retention", () => {
  it("keeps an early merged child writable and releases both children after the last merge", async () => {
    await using project = await tmpdir()
    await using runtime = await tmpdir()
    const f = await setup(project.path, runtime.path)
    await f.approve("s1_t1")
    expect(await f.protocol.merge(f.ctx, { task_id: "s1_t1" })).toMatchObject({
      ok: true,
      status: "merged",
      cleanup: "pending",
    })
    const early = f.starts.get("s1_t1")!
    expect(f.stopped).toEqual([])
    fs.writeFileSync(path.join(early.brief.workspace_root, "discussion.txt"), "Can still answer and work")
    expect(await f.protocol.merge(f.ctx, { task_id: "s1_t1" })).toMatchObject({
      ok: true,
      status: "already_merged",
      cleanup: "pending",
    })
    expect(f.stopped).toEqual([])
    expect((await f.read()).current_step).toBe("s1")
    await f.approve("s1_t2")
    expect(await f.protocol.merge(f.ctx, { task_id: "s1_t2" })).toMatchObject({
      ok: true,
      status: "merged",
      cleanup: "completed",
    })
    const plan = await f.read()
    expect(plan.current_step).toBe("s2")
    expect(plan.steps[0].tasks.map((task) => task.merge?.cleanup)).toEqual(["completed", "completed"])
    expect(new Set(f.stopped)).toEqual(new Set([...f.starts.values()].map((input) => input.childSessionId)))
    for (const task of plan.steps[0].tasks) {
      expect(fs.existsSync(task.dispatch!.workspace!.directory!)).toBe(false)
      expect(fs.existsSync(task.dispatch!.workspace!.baseline_directory!)).toBe(false)
    }
    expect(fs.readFileSync(path.join(project.path, "early.md"), "utf8")).toContain("s1_t1")
    expect(fs.readFileSync(path.join(project.path, "slow.md"), "utf8")).toContain("s1_t2")
  })

  it("protects merged siblings from restart recovery and background reclamation", async () => {
    await using project = await tmpdir()
    await using runtime = await tmpdir()
    const f = await setup(project.path, runtime.path)
    await f.approve("s1_t1")
    expect(await f.protocol.merge(f.ctx, { task_id: "s1_t1" })).toMatchObject({ ok: true, cleanup: "pending" })
    const early = (await f.read()).steps[0].tasks[0]
    const references = collectPlanReferences([project.path], [runtime.path], true, Date.now() + 30 * 86400000)
    for (const directory of [
      early.dispatch!.workspace!.directory!,
      early.dispatch!.workspace!.baseline_directory!,
      early.merge!.journal_directory!,
    ]) {
      expect(references.get(path.resolve(directory))?.active).toBe(true)
    }
    const recovery = new PlanRecovery({
      workspaceRoot: project.path,
      store: f.protocol.store,
      childWorkspace: f.childWorkspace,
      children: f.children,
      isChildActive: async () => true,
    })
    expect((await recovery.reconcilePlan("ses_main")).errors).toEqual([])
    expect(f.stopped).toEqual([])
    fs.writeFileSync(path.join(early.dispatch!.workspace!.directory!, "reply.txt"), "Still writable after restart")
    expect((await f.read()).steps[0].tasks[0].merge?.cleanup).toBe("pending")
  })

  it("retries failed Step cleanup without reapplying a merge", async () => {
    await using project = await tmpdir()
    await using runtime = await tmpdir()
    const f = await setup(project.path, runtime.path)
    await f.approve("s1_t1")
    await f.protocol.merge(f.ctx, { task_id: "s1_t1" })
    await f.approve("s1_t2")
    const remove = f.childWorkspace.remove.bind(f.childWorkspace)
    let fail = true
    const earlyDirectory = f.starts.get("s1_t1")!.brief.workspace_root
    f.childWorkspace.remove = async (directory, guard) => {
      if (directory === earlyDirectory && fail) {
        fail = false
        throw new Error("Simulated cleanup interruption")
      }
      return remove(directory, guard)
    }
    expect(await f.protocol.merge(f.ctx, { task_id: "s1_t2" })).toMatchObject({ ok: true, status: "merged" })
    expect((await f.read()).steps[0].tasks[0].merge?.cleanup).toBe("failed")
    expect(await f.protocol.merge(f.ctx, { task_id: "s1_t2" })).toMatchObject({ ok: true, status: "already_merged" })
    expect((await f.read()).steps[0].tasks.map((task) => task.merge?.cleanup)).toEqual(["completed", "completed"])
    expect((await f.read()).steps[0].tasks.map((task) => task.merge?.attempt)).toEqual([1, 1])
  })

  it("releases deferred siblings when recovery finishes the last merge", async () => {
    await using project = await tmpdir()
    await using runtime = await tmpdir()
    const f = await setup(project.path, runtime.path)
    await f.approve("s1_t1")
    await f.protocol.merge(f.ctx, { task_id: "s1_t1" })
    await f.approve("s1_t2")
    const stored = await f.read()
    const merge = stored.steps[0].tasks[1].merge!
    merge.status = "running"
    merge.cleanup = "pending"
    merge.journal_directory = path.join(runtime.path, "last-merge-journal")
    fs.writeFileSync(planFilePath(project.path, "ses_main"), JSON.stringify(stored))
    const recovery = new PlanRecovery({
      workspaceRoot: project.path,
      store: f.protocol.store,
      childWorkspace: f.childWorkspace,
      children: f.children,
    })
    expect((await recovery.reconcilePlan("ses_main")).errors).toEqual([])
    expect((await f.read()).steps[0].tasks.map((task) => task.merge?.cleanup)).toEqual(["completed", "completed"])
    for (const input of f.starts.values()) expect(fs.existsSync(input.brief.workspace_root)).toBe(false)
  })
})
