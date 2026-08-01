import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { describe, expect, it } from "bun:test"
import { PlanProtocol } from "../../src/plan/protocol"
import { PlanEventHub, PlanInbox, WakeupQueue, validatePlanEvent } from "../../src/plan/events"
import { AGING_MS, PlanStore, STALE_LOCK_MS } from "../../src/plan/store"
import { planFilePath, validatePlanFile } from "../../src/plan/schema"
import { projectPlanSnapshot, validatePlanSnapshot } from "../../src/plan/snapshot"
import { planSystemPrompt } from "../../src/plan/prompts"

function workspace() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "jyycode-plan-"))
}

function context(root: string, mode: "single" | "multi" = "multi", sessionId = "ses_main") {
  return { workspaceRoot: root, sessionId, mode }
}

function createInput(outputPath?: string) {
  return {
    title: "重构用户模块",
    goal: "按阶段完成模块重构并通过验收",
    steps: [
      {
        title: "现状分析",
        goal: "梳理现状",
        done_criteria: "产出分析文件",
        tasks: [
          {
            title: "梳理依赖",
            goal: "列出依赖",
            done_criteria: "依赖文件存在",
            ...(outputPath ? { output_path: outputPath } : {}),
          },
        ],
      },
      { title: "实现验收", goal: "完成实现", done_criteria: "测试全部通过" },
    ],
  }
}

describe("file-backed plan protocol", () => {
  it("creates, reads, and returns progress using the specified schema", async () => {
    const root = workspace()
    const protocol = new PlanProtocol({ store: new PlanStore(), events: new PlanEventHub(), inbox: new PlanInbox() })
    const created = await protocol.create(context(root), createInput())
    expect(created.ok).toBe(true)
    if (!created.ok) return
    expect(created.plan_id_assigned).toEqual({ steps: ["s1", "s2"], tasks: { s1: ["s1_t1"], s2: [] } })
    const read = await protocol.read(context(root))
    expect(read.ok).toBe(true)
    if (!read.ok) return
    expect(read.plan?.revision).toBe(1)
    expect(read.plan?.current_step).toBe("s1")
    expect(read.progress?.task_counts.pending).toBe(1)
    expect(read.progress?.next_action_hint).toContain("pending")
    expect(fs.existsSync(planFilePath(root, "ses_main"))).toBe(true)
  })

  it("rejects tasks on later create steps and rejects duplicate plans", async () => {
    const root = workspace()
    const protocol = new PlanProtocol({ store: new PlanStore() })
    const invalid = await protocol.create(context(root), {
      ...createInput(),
      steps: [
        { ...createInput().steps[0] },
        { ...createInput().steps[1], tasks: [{ title: "x", goal: "x", done_criteria: "x" }] },
      ],
    })
    expect(invalid.ok).toBe(false)
    if (invalid.ok) return
    expect(invalid.error.code).toBe("SCHEMA_VALIDATION")
    expect(invalid.error.message).toContain("steps[1]")
    expect((await protocol.create(context(root), createInput())).ok).toBe(true)
    const duplicate = await protocol.create(context(root), createInput())
    expect(duplicate.ok).toBe(false)
    if (!duplicate.ok) expect(duplicate.error.hint).toContain("Plan.update")
  })

  it("rejects caller-supplied priority so write priority remains runtime-derived", async () => {
    const root = workspace()
    const protocol = new PlanProtocol({ store: new PlanStore() })
    const forged = await protocol.create(context(root), { ...createInput(), priority: "high" })
    expect(forged.ok).toBe(false)
    if (!forged.ok) {
      expect(forged.error.code).toBe("SCHEMA_VALIDATION")
      expect(forged.error.message).toContain("priority")
    }
    expect(fs.existsSync(planFilePath(root, "ses_main"))).toBe(false)
  })

  it("applies all update ops atomically and maintains current_step", async () => {
    const root = workspace()
    const protocol = new PlanProtocol({ store: new PlanStore() })
    await protocol.create(context(root, "single"), createInput())
    const failed = await protocol.update(context(root, "single"), {
      revision: 1,
      ops: [
        { op: "add_task", stepId: "s1", task: { title: "extra", goal: "extra", done_criteria: "extra" } },
        { op: "edit_task", stepId: "s1", taskId: "missing", fields: { title: "never" } },
      ],
    })
    expect(failed.ok).toBe(false)
    if (!failed.ok) expect(failed.error.rolled_back).toBe(true)
    const unchanged = await protocol.read(context(root, "single"))
    if (!unchanged.ok || !unchanged.plan) return
    expect(unchanged.plan.revision).toBe(1)
    expect(unchanged.plan.steps[0]?.tasks).toHaveLength(1)

    const premature = await protocol.update(context(root, "single"), {
      revision: 1,
      ops: [{ op: "add_task", stepId: "s2", task: { title: "实现", goal: "实现", done_criteria: "测试通过" } }],
    })
    expect(premature.ok).toBe(false)
    const advanced = await protocol.update(context(root, "single"), {
      revision: 1,
      ops: [
        { op: "set_task_status", stepId: "s1", taskId: "s1_t1", to: "running" },
        { op: "set_task_status", stepId: "s1", taskId: "s1_t1", to: "reported" },
        { op: "set_task_status", stepId: "s1", taskId: "s1_t1", to: "approved" },
      ],
    })
    expect(advanced.ok).toBe(true)
    const expanded = await protocol.update(context(root, "single"), {
      revision: 2,
      ops: [{ op: "add_task", stepId: "s2", task: { title: "实现", goal: "实现", done_criteria: "测试通过" } }],
    })
    expect(expanded.ok).toBe(true)
    if (!expanded.ok) return
    expect(expanded.assigned_ids?.tasks).toEqual(["s2_t1"])
    expect(expanded.revision).toBe(3)
  })

  it("enforces single-agent status transitions and revision conflicts", async () => {
    const root = workspace()
    const protocol = new PlanProtocol({ store: new PlanStore() })
    await protocol.create(context(root, "single"), createInput())
    expect(
      (
        await protocol.update(context(root, "single"), {
          revision: 1,
          ops: [{ op: "set_task_status", stepId: "s1", taskId: "s1_t1", to: "running" }],
        })
      ).ok,
    ).toBe(true)
    const conflict = await protocol.update(context(root, "single"), {
      revision: 1,
      ops: [{ op: "set_task_status", stepId: "s1", taskId: "s1_t1", to: "reported" }],
    })
    expect(conflict.ok).toBe(false)
    if (!conflict.ok) {
      expect(conflict.error.code).toBe("REVISION_CONFLICT")
      expect(conflict.error.latest_revision).toBe(2)
    }
    const skipped = await protocol.update(context(root, "single"), {
      revision: 2,
      ops: [{ op: "set_task_status", stepId: "s1", taskId: "s1_t1", to: "approved" }],
    })
    expect(skipped.ok).toBe(false)
    if (!skipped.ok) expect(skipped.error.code).toBe("INVALID_STATE")
  })

  it("dispatches, reports, emits report_arrived, and feeds review feedback back into dispatch", async () => {
    const root = workspace()
    const artifact = path.join(root, "deps.md")
    fs.writeFileSync(artifact, "all dependencies")
    const events = new PlanEventHub()
    const wakeups = new WakeupQueue()
    const inbox = new PlanInbox()
    let brief: unknown
    let statusAtStart: string | undefined
    const protocol = new PlanProtocol({
      store: new PlanStore(),
      events,
      wakeups,
      inbox,
      children: {
        async create(input) {
          return input.childSessionId
        },
        async start(input) {
          brief = input.brief
          const state = await protocol.read(context(root))
          statusAtStart = state.ok ? state.plan?.steps[0]?.tasks[0]?.status : undefined
        },
        async terminate() {},
      },
    })
    await protocol.create(context(root), createInput(artifact))
    const dispatched = await protocol.dispatch(context(root), ["s1_t1"])
    expect(dispatched.ok).toBe(true)
    if (!dispatched.ok) return
    expect(dispatched.dispatched[0]?.idempotent).toBe(false)
    expect(statusAtStart).toBe("running")
    const runId = dispatched.dispatched[0]!.run_id
    const report = await protocol.report(
      { ...context(root, "single", "child_ses_main_s1_t1"), runId },
      { run_id: runId, status: "done", summary: "依赖已梳理", artifacts: [artifact], issues: [] },
    )
    expect(report.ok).toBe(true)
    if (!report.ok) return
    expect(report.review).toBe("pending_review")
    expect(wakeups.drain("ses_main")).toHaveLength(1)
    const read = await protocol.read(context(root))
    if (!read.ok || !read.plan) return
    const review = await protocol.update(context(root), {
      revision: read.plan.revision,
      ops: [
        { op: "review_task", stepId: "s1", taskId: "s1_t1", decision: "reject", feedback: "还需覆盖 tests/ 调用方" },
      ],
    })
    expect(review.ok).toBe(true)
    const afterReview = await protocol.read(context(root))
    if (!afterReview.ok || !afterReview.plan) return
    const rejected = await protocol.dispatch(context(root), ["s1_t1"])
    expect(rejected.ok).toBe(true)
    expect((brief as { previous_feedback?: { review_feedback: string } }).previous_feedback?.review_feedback).toContain(
      "tests/",
    )
  })

  it("keeps report retry state and Inbox entries across protocol calls", async () => {
    const root = workspace()
    const missingArtifact = path.join(root, "not-created.md")
    const rootContext = context(root)
    const creator = new PlanProtocol()
    await creator.create(rootContext, createInput(missingArtifact))
    const dispatched = await creator.dispatch(rootContext, ["s1_t1"])
    expect(dispatched.ok).toBe(true)
    if (!dispatched.ok) return
    const runId = dispatched.dispatched[0]!.run_id
    const childContext = { ...context(root, "single", "child_retry"), runId }

    const first = await new PlanProtocol().report(childContext, {
      run_id: runId,
      status: "done",
      summary: "文件尚未生成",
      artifacts: [missingArtifact],
      issues: ["产出文件缺失"],
    })
    expect(first.ok).toBe(false)
    if (!first.ok) expect(first.error.retryable).toBe(true)

    const second = await new PlanProtocol().report(childContext, {
      run_id: runId,
      status: "done",
      summary: "文件仍未生成",
      artifacts: [missingArtifact],
      issues: ["产出文件缺失"],
    })
    expect(second.ok).toBe(true)
    if (!second.ok) return
    expect(second.review).toBe("rejected_precheck")

    const read = await new PlanProtocol().read(rootContext)
    if (!read.ok || !read.progress) return
    expect(read.progress.inbox_pending).toBe(1)
    const inbox = await new PlanProtocol().readInbox(rootContext)
    expect(inbox.ok).toBe(true)
    if (!inbox.ok) return
    expect(inbox.items[0]?.kind).toBe("report_precheck_failed")
    const handled = await new PlanProtocol().readInbox(rootContext, { mark_handled: [inbox.items[0]!.id] })
    expect(handled).toEqual({ ok: true, items: [] })
  })

  it("covers the nine-op protection matrix and rejects malformed stored plans", async () => {
    const doneRoot = workspace()
    const doneProtocol = new PlanProtocol()
    await doneProtocol.create(context(doneRoot, "single"), createInput())
    const advanced = await doneProtocol.update(context(doneRoot, "single"), {
      revision: 1,
      ops: [
        { op: "set_task_status", stepId: "s1", taskId: "s1_t1", to: "running" },
        { op: "set_task_status", stepId: "s1", taskId: "s1_t1", to: "reported" },
        { op: "set_task_status", stepId: "s1", taskId: "s1_t1", to: "approved" },
      ],
    })
    expect(advanced.ok).toBe(true)
    const expanded = await doneProtocol.update(context(doneRoot, "single"), {
      revision: 2,
      ops: [{ op: "add_task", stepId: "s2", task: { title: "实现", goal: "实现", done_criteria: "通过测试" } }],
    })
    expect(expanded.ok).toBe(true)
    const completed = await doneProtocol.update(context(doneRoot, "single"), {
      revision: 3,
      ops: [
        { op: "set_task_status", stepId: "s2", taskId: "s2_t1", to: "running" },
        { op: "set_task_status", stepId: "s2", taskId: "s2_t1", to: "reported" },
        { op: "set_task_status", stepId: "s2", taskId: "s2_t1", to: "approved" },
      ],
    })
    expect(completed.ok).toBe(true)
    for (const ops of [
      [{ op: "edit_plan", fields: { title: "改名" } }],
      [{ op: "add_step", after: "s1", step: { title: "插入", goal: "插入", done_criteria: "完成" } }],
      [{ op: "edit_step", stepId: "s1", fields: { title: "改阶段" } }],
      [{ op: "remove_step", stepId: "s1" }],
      [{ op: "add_task", stepId: "s1", task: { title: "追加", goal: "追加", done_criteria: "完成" } }],
    ] as const) {
      const result = await doneProtocol.update(context(doneRoot, "single"), { revision: 4, ops })
      expect(result.ok).toBe(false)
      if (!result.ok) expect(result.error.rolled_back).toBe(true)
    }

    const runningRoot = workspace()
    const runningProtocol = new PlanProtocol()
    await runningProtocol.create(context(runningRoot, "single"), createInput())
    await runningProtocol.update(context(runningRoot, "single"), {
      revision: 1,
      ops: [{ op: "set_task_status", stepId: "s1", taskId: "s1_t1", to: "running" }],
    })
    for (const ops of [
      [{ op: "edit_task", stepId: "s1", taskId: "s1_t1", fields: { title: "改任务" } }],
      [{ op: "remove_task", stepId: "s1", taskId: "s1_t1" }],
    ] as const) {
      const result = await runningProtocol.update(context(runningRoot, "single"), { revision: 2, ops })
      expect(result.ok).toBe(false)
      if (!result.ok) expect(result.error.code).toBe("INVALID_STATE")
    }

    const multiRoot = workspace()
    const multiProtocol = new PlanProtocol()
    await multiProtocol.create(context(multiRoot), createInput())
    const singleOnly = await multiProtocol.update(context(multiRoot), {
      revision: 1,
      ops: [{ op: "set_task_status", stepId: "s1", taskId: "s1_t1", to: "running" }],
    })
    expect(singleOnly).toMatchObject({ ok: false, error: { code: "DISPATCH_UNAVAILABLE" } })
    const multiReview = await multiProtocol.update(context(multiRoot), {
      revision: 1,
      ops: [{ op: "review_task", stepId: "s1", taskId: "s1_t1", decision: "approve" }],
    })
    expect(multiReview).toMatchObject({ ok: false, error: { code: "INVALID_STATE" } })
    const missingFeedback = await multiProtocol.update(context(multiRoot), {
      revision: 1,
      ops: [{ op: "review_task", stepId: "s1", taskId: "s1_t1", decision: "reject" }],
    })
    expect(missingFeedback).toMatchObject({ ok: false, error: { code: "SCHEMA_VALIDATION" } })

    const storedRead = await new PlanProtocol().read(context(doneRoot, "single"))
    if (!storedRead.ok || !storedRead.plan) return
    const malformed = JSON.parse(JSON.stringify(storedRead.plan))
    delete malformed.steps[0].tasks[0].report
    expect(validatePlanFile(malformed)).toContain("plan.steps[0].tasks[0].report: invalid report record")
  })

  it("returns UI snapshots and keeps activity events out of plan.json", async () => {
    const root = workspace()
    const protocol = new PlanProtocol({ store: new PlanStore() })
    await protocol.create(context(root), createInput())
    protocol.recordActivity({
      workspaceRoot: root,
      parentSessionId: "ses_main",
      taskId: "s1_t1",
      runId: "run__ses_main__s1_t1",
      activity: "执行测试",
    })
    const snapshot = protocol.snapshot(context(root))
    if ("plan" in snapshot) return
    expect(snapshot.steps[0]?.tasks[0]?.id).toBe("s1_t1")
    const stored = JSON.parse(fs.readFileSync(planFilePath(root, "ses_main"), "utf8")) as { revision: number }
    expect(stored.revision).toBe(1)
    expect(projectPlanSnapshot(null)).toEqual({ plan: null })
    const activityBase = Date.now() + 2000
    const first = protocol.recordActivity({
      workspaceRoot: root,
      parentSessionId: "ses_main",
      taskId: "s1_t1",
      runId: "run__ses_main__s1_t1",
      activity: "继续执行",
      at: new Date(activityBase).toISOString(),
    })
    const throttled = protocol.recordActivity({
      workspaceRoot: root,
      parentSessionId: "ses_main",
      taskId: "s1_t1",
      runId: "run__ses_main__s1_t1",
      activity: "仍在执行",
      at: new Date(activityBase + 500).toISOString(),
    })
    expect(first).toBeDefined()
    expect(throttled).toBeUndefined()
  })

  it("validates event envelopes and UI snapshots", async () => {
    const root = workspace()
    const protocol = new PlanProtocol({ store: new PlanStore() })
    await protocol.create(context(root), createInput())
    const snapshot = protocol.snapshot(context(root))
    expect(validatePlanSnapshot(snapshot)).toEqual([])
    const event = new PlanEventHub().publish({
      type: "plan.updated",
      session_id: "ses_main",
      revision: 1,
      payload: snapshot,
    })
    expect(validatePlanEvent(event)).toEqual([])
    expect(validatePlanEvent({ ...event, seq: -1 })).not.toEqual([])
  })

  it("derives system prompts by session mode", () => {
    expect(planSystemPrompt({ child: true, multiAgent: true })).toContain("Report")
    expect(planSystemPrompt({ child: false, multiAgent: true })).toContain("Dispatch_dispatch")
    expect(planSystemPrompt({ child: false, multiAgent: false })).toContain("pending→running")
  })

  it("prioritizes main writes, ages normal writes, times out, and reclaims stale locks", async () => {
    const root = workspace()
    const planPath = planFilePath(root, "ses_main")
    const events: string[] = []
    const store = new PlanStore({
      pollMs: 1,
      waitTimeoutMs: 25,
      agingMs: AGING_MS,
      staleLockMs: STALE_LOCK_MS,
      isProcessAlive: () => false,
    })
    const base = {
      title: "x",
      goal: "x",
      status: "active" as const,
      revision: 1,
      current_step: "s1",
      steps: [{ id: "s1", title: "x", goal: "x", done_criteria: "x", status: "active" as const, tasks: [] }],
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    }
    await store.enqueueWrite(planPath, {
      priority: "high",
      holder: "main",
      apply: () => ({
        mutate(target) {
          Object.assign(target, base)
        },
        result: "base",
      }),
    })
    const normal = store.enqueueWrite(planPath, {
      priority: "normal",
      holder: "child",
      apply: (latest) => ({
        mutate(target) {
          Object.assign(target, latest!, { revision: latest!.revision + 1 })
        },
        result: "normal",
      }),
    })
    const high = store.enqueueWrite(planPath, {
      priority: "high",
      holder: "main",
      apply: (latest) => ({
        mutate(target) {
          Object.assign(target, latest!, { revision: latest!.revision + 1 })
        },
        result: "high",
      }),
    })
    expect(await Promise.all([normal, high])).toEqual(expect.arrayContaining(["normal", "high"]))
    fs.writeFileSync(
      `${planPath}.lock`,
      JSON.stringify({ pid: 999999, holder: "busy", acquired_at: new Date().toISOString() }),
    )
    await expect(
      store.enqueueWrite(planPath, {
        priority: "normal",
        holder: "child",
        retryableOnTimeout: true,
        apply: () => ({ mutate() {}, result: "never" }),
      }),
    ).rejects.toMatchObject({ code: "REVISION_CONFLICT", retryable: true })
    fs.writeFileSync(
      `${planPath}.lock`,
      JSON.stringify({
        pid: 999999,
        holder: "dead",
        acquired_at: new Date(Date.now() - STALE_LOCK_MS - 1).toISOString(),
      }),
    )
    const recovered = await store.enqueueWrite(planPath, {
      priority: "high",
      holder: "main",
      apply: (latest) => ({
        mutate(target) {
          Object.assign(target, latest!, { revision: latest!.revision + 1 })
        },
        result: "recovered",
      }),
    })
    expect(recovered).toBe("recovered")
    expect(events).toHaveLength(0)
  })
})
