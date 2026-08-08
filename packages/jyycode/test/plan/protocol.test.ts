import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { describe, expect, it } from "bun:test"
import { PlanProtocol } from "../../src/plan/protocol"
import { PlanEventHub, PlanInbox, WakeupQueue, validatePlanEvent } from "../../src/plan/events"
import { AGING_MS, PlanStore, STALE_LOCK_MS } from "../../src/plan/store"
import { planFilePath, PlanProtocolError, validatePlanFile } from "../../src/plan/schema"
import { projectPlanSnapshot, validatePlanSnapshot } from "../../src/plan/snapshot"
import { planSystemPrompt } from "../../src/plan/prompts"
import { defaultGeneralProfile } from "../../src/agent/subagent-profile"
import {
  createFakeArtifact,
  createHardeningChildren,
  createHardeningWorkspace,
  hardeningContext,
  hardeningPlanInput,
  readHardeningPlan,
} from "./hardening-fixtures"

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
  it("requires an enabled named role and persists its dispatch snapshot", async () => {
    const root = workspace()
    const profiles = [
      defaultGeneralProfile,
      {
        id: "reviewer",
        name: "Reviewer",
        description: "Checks delegated work.",
        prompt: "Review the output carefully.",
        avatar: "bug" as const,
        enabled: true,
      },
      {
        id: "disabled",
        name: "Disabled",
        description: "Unavailable role.",
        prompt: "",
        avatar: "bot" as const,
        enabled: false,
      },
    ]
    const protocol = new PlanProtocol({ store: new PlanStore(), profiles: async () => profiles })
    await protocol.create(context(root), createInput(path.join(root, "notes.md")))

    const missing = await protocol.dispatch(context(root), { taskIds: ["s1_t1"] })
    expect(missing).toMatchObject({ ok: false, error: { code: "SCHEMA_VALIDATION" } })
    const unknown = await protocol.dispatch(context(root), { taskIds: ["s1_t1"], role: "missing" })
    expect(unknown).toMatchObject({ ok: false, error: { code: "DISPATCH_UNAVAILABLE" } })
    const disabled = await protocol.dispatch(context(root), { taskIds: ["s1_t1"], role: "disabled" })
    expect(disabled).toMatchObject({ ok: false, error: { code: "DISPATCH_UNAVAILABLE" } })

    const dispatched = await protocol.dispatch(context(root), { taskIds: ["s1_t1"], role: "reviewer" })
    expect(dispatched).toMatchObject({ ok: true, dispatched: [{ idempotent: false }] })
    const read = await protocol.read(context(root))
    if (!read.ok || !read.plan) return
    expect(read.plan.steps[0]?.tasks[0]?.dispatch?.role).toEqual({
      id: "reviewer",
      name: "Reviewer",
      description: "Checks delegated work.",
      avatar: "bug",
    })
    const snapshot = projectPlanSnapshot(read.plan)
    if ("plan" in snapshot) return
    expect(snapshot.steps[0]?.tasks[0]?.role).toEqual({
      id: "reviewer",
      name: "Reviewer",
      description: "Checks delegated work.",
      avatar: "bug",
    })
  })

  it("resolves a fresh role when a cancelled task is retried", async () => {
    const root = workspace()
    const profiles = [defaultGeneralProfile]
    const protocol = new PlanProtocol({ store: new PlanStore(), profiles: async () => profiles })
    await protocol.create(context(root), createInput(path.join(root, "notes.md")))
    await protocol.dispatch(context(root), { taskIds: ["s1_t1"], role: "general" })
    expect((await protocol.cancel(context(root), ["s1_t1"])).ok).toBe(true)

    profiles.push({
      id: "reviewer",
      name: "Reviewer",
      description: "Checks delegated work.",
      prompt: "",
      avatar: "bug",
      enabled: true,
    })
    const retried = await protocol.dispatch(context(root), { taskIds: ["s1_t1"], role: "reviewer" })
    expect(retried).toMatchObject({ ok: true, dispatched: [{ idempotent: false }] })
    const read = await protocol.read(context(root))
    if (!read.ok || !read.plan) return
    expect(read.plan.steps[0]?.tasks[0]?.dispatch?.role?.id).toBe("reviewer")
  })

  it("cancels approved and already-cancelled dispatches idempotently", async () => {
    const root = workspace()
    let terminations = 0
    const protocol = new PlanProtocol({
      store: new PlanStore(),
      children: {
        async create(input) {
          return input.childSessionId
        },
        async start() {},
        async terminate() {
          terminations++
        },
      },
    })
    await protocol.create(context(root), createInput(path.join(root, "notes.md")))
    await protocol.dispatch(context(root), { taskIds: ["s1_t1"], role: "general" })

    const stored = JSON.parse(fs.readFileSync(planFilePath(root, "ses_main"), "utf8")) as {
      steps: Array<{ tasks: Array<{ status: string }> }>
    }
    stored.steps[0]!.tasks[0]!.status = "approved"
    fs.writeFileSync(planFilePath(root, "ses_main"), JSON.stringify(stored))

    expect(await protocol.cancel(context(root), ["s1_t1"])).toMatchObject({
      ok: true,
      next_action_hint: expect.stringContaining("pending/rejected"),
    })
    expect(await protocol.cancel(context(root), ["s1_t1"])).toMatchObject({ ok: true })
    expect(terminations).toBe(1)

    const read = await protocol.read(context(root))
    if (!read.ok || !read.plan) return
    expect(read.plan.steps[0]?.tasks[0]?.status).toBe("pending")
    expect(read.plan.steps[0]?.tasks[0]?.dispatch?.cancelled_at).not.toBeNull()
  })

  it("persists cancellation when child cleanup fails", async () => {
    const root = workspace()
    const protocol = new PlanProtocol({
      store: new PlanStore(),
      children: {
        async create(input) {
          return input.childSessionId
        },
        async start() {},
        async terminate() {
          throw new Error("child session already gone")
        },
      },
    })
    await protocol.create(context(root), createInput(path.join(root, "notes.md")))
    await protocol.dispatch(context(root), { taskIds: ["s1_t1"], role: "general" })

    const cancelled = await protocol.cancel(context(root), ["s1_t1"])
    expect(cancelled).toMatchObject({
      ok: true,
      termination_errors: [{ taskId: "s1_t1", message: "child session already gone" }],
    })
    const read = await protocol.read(context(root))
    if (!read.ok || !read.plan) return
    expect(read.plan.steps[0]?.tasks[0]?.status).toBe("pending")
  })

  it("passes an immutable launch snapshot to the child controller", async () => {
    const root = workspace()
    const profiles = [
      defaultGeneralProfile,
      {
        id: "reviewer",
        name: "Reviewer",
        description: "Checks delegated work.",
        prompt: "Use the review checklist.",
        avatar: "bug" as const,
        model: "openai/gpt-5",
        variant: "low",
        enabled: true,
      },
    ]
    let started:
      | {
          role: unknown
          brief: {
            task_title: string
            task_instructions?: string
            step_context: { plan_goal: string; step_id: string; step_title: string }
          }
        }
      | undefined
    const protocol = new PlanProtocol({
      store: new PlanStore(),
      profiles: async () => profiles,
      children: {
        async create(input) {
          started = input
          return input.childSessionId
        },
        async start(input) {
          started = input
        },
        async terminate() {},
      },
    })
    const input = createInput(path.join(root, "notes.md"))
    await protocol.create(context(root), {
      ...input,
      steps: [
        {
          ...input.steps[0]!,
          tasks: [
            {
              ...input.steps[0]!.tasks![0]!,
              instructions: "Read the existing API and preserve the public contract.",
            },
          ],
        },
        input.steps[1]!,
      ],
    })
    await protocol.dispatch(context(root), { taskIds: ["s1_t1"], role: "reviewer" })
    profiles[1] = { ...profiles[1]!, name: "Edited", prompt: "Changed", model: "anthropic/claude", variant: "high" }
    expect(started?.role).toEqual({
      id: "reviewer",
      name: "Reviewer",
      description: "Checks delegated work.",
      prompt: "Use the review checklist.",
      avatar: "bug",
      model: "openai/gpt-5",
      variant: "low",
    })
    expect(started?.brief).toMatchObject({
      task_title: "梳理依赖",
      task_instructions: "Read the existing API and preserve the public contract.",
      step_context: { plan_goal: "按阶段完成模块重构并通过验收", step_id: "s1", step_title: "现状分析" },
    })
  })

  it("anchors a relative dispatched output_path at the workspace root", async () => {
    const root = workspace()
    let captured: { brief: { workspace_root: string; output_path: string } } | undefined
    const protocol = new PlanProtocol({
      store: new PlanStore(),
      profiles: async () => [defaultGeneralProfile],
      children: {
        async create(input) {
          captured = input
          return input.childSessionId
        },
        async start() {},
        async terminate() {},
      },
    })
    await protocol.create(context(root), createInput(path.join("notes", "notes.md")))
    const dispatched = await protocol.dispatch(context(root), { taskIds: ["s1_t1"], role: "general" })
    expect(dispatched.ok).toBe(true)
    expect(captured?.brief.workspace_root).toBe(path.resolve(root))
    expect(captured?.brief.output_path).toBe(path.resolve(root, "notes", "notes.md"))
  })

  it("rejects an output_path escaping the workspace at create time", async () => {
    const root = workspace()
    let created = false
    const protocol = new PlanProtocol({
      store: new PlanStore(),
      profiles: async () => [defaultGeneralProfile],
      children: {
        async create(input) {
          created = true
          return input.childSessionId
        },
        async start() {},
        async terminate() {},
      },
    })
    const createdPlan = await protocol.create(context(root), createInput(path.join("..", "escape.md")))
    expect(createdPlan).toMatchObject({ ok: false, error: { code: "SCHEMA_VALIDATION" } })
    expect(created).toBe(false)
    expect(fs.existsSync(planFilePath(root, "ses_main"))).toBe(false)
  })

  it("rejects an output_path with a stray drive prefix at create time", async () => {
    const root = workspace()
    const protocol = new PlanProtocol({ store: new PlanStore() })
    const result = await protocol.create(
      context(root),
      createInput(`c:/${root.replace(/\\/g, "/")}/notes.md`),
    )
    expect(result).toMatchObject({ ok: false, error: { code: "SCHEMA_VALIDATION" } })
  })

  it("still rejects a persisted output_path escaping the workspace at dispatch time", async () => {
    const root = workspace()
    let created = false
    const protocol = new PlanProtocol({
      store: new PlanStore(),
      profiles: async () => [defaultGeneralProfile],
      children: {
        async create(input) {
          created = true
          return input.childSessionId
        },
        async start() {},
        async terminate() {},
      },
    })
    await protocol.create(context(root), createInput("notes.md"))
    const file = planFilePath(root, "ses_main")
    const raw = fs.readFileSync(file, "utf8")
    fs.writeFileSync(file, raw.replace('"output_path": "notes.md"', '"output_path": "../escape.md"'))
    const dispatched = await protocol.dispatch(context(root), { taskIds: ["s1_t1"], role: "general" })
    expect(dispatched).toMatchObject({ ok: false, error: { code: "SCHEMA_VALIDATION" } })
    expect(created).toBe(false)
  })

  it("rejects out-of-workspace output_path in Plan_update add_task and edit_task", async () => {
    const root = workspace()
    const protocol = new PlanProtocol({ store: new PlanStore() })
    await protocol.create(context(root), createInput())

    const add = await protocol.update(context(root), {
      revision: 1,
      ops: [
        {
          op: "add_task",
          stepId: "s1",
          task: { title: "bad", goal: "bad", done_criteria: "bad", output_path: "../escape.md" },
        },
      ],
    })
    expect(add).toMatchObject({ ok: false, error: { code: "SCHEMA_VALIDATION" } })

    const edit = await protocol.update(context(root), {
      revision: 1,
      ops: [{ op: "edit_task", stepId: "s1", taskId: "s1_t1", fields: { output_path: "../escape.md" } }],
    })
    expect(edit).toMatchObject({ ok: false, error: { code: "SCHEMA_VALIDATION" } })
  })

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
    if (!duplicate.ok) expect(duplicate.error.hint).toContain("Plan_update")
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
    const dispatched = await protocol.dispatch(context(root), { taskIds: ["s1_t1"], role: "general" })
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
    const rejected = await protocol.dispatch(context(root), { taskIds: ["s1_t1"], role: "general" })
    expect(rejected.ok).toBe(true)
    expect((brief as { previous_feedback?: { review_feedback: string } }).previous_feedback?.review_feedback).toContain(
      "tests/",
    )
  })

  it("keeps report retry state and Inbox entries across protocol calls", async () => {
    const root = workspace()
    const missingArtifact = path.join(root, "not-created.md")
    const rootContext = context(root)
    const creator = new PlanProtocol({ children: createHardeningChildren().controller })
    await creator.create(rootContext, createInput(missingArtifact))
    const dispatched = await creator.dispatch(rootContext, { taskIds: ["s1_t1"], role: "general" })
    expect(dispatched.ok).toBe(true)
    if (!dispatched.ok) return
    const runId = dispatched.dispatched[0]!.run_id
    const childContext = { ...context(root, "single", "child_retry"), runId }

    const first = await creator.report(childContext, {
      run_id: runId,
      status: "done",
      summary: "文件尚未生成",
      artifacts: [missingArtifact],
      issues: ["产出文件缺失"],
    })
    expect(first.ok).toBe(false)
    if (!first.ok) expect(first.error.retryable).toBe(true)

    const second = await creator.report(childContext, {
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

  it("only accepts the first Report from a running task and keeps duplicate reports idempotent", async () => {
    const fixture = createHardeningWorkspace()
    try {
      const outputPath = path.join(fixture.root, "output")
      const artifact = createFakeArtifact(path.join(outputPath, "report.md"))
      expect(artifact.write()).toBe(true)
      const children = createHardeningChildren()
      const protocol = new PlanProtocol({ store: new PlanStore(), children: children.controller })
      const root = hardeningContext(fixture.root)
      await protocol.create(root, hardeningPlanInput(outputPath))
      const dispatched = await protocol.dispatch(root, { taskIds: ["s1_t1"], role: "general" })
      expect(dispatched.ok).toBe(true)
      if (!dispatched.ok) return
      const runId = dispatched.dispatched[0]!.run_id
      const child = { ...hardeningContext(fixture.root, "child_s1_t1", "single"), runId }

      const first = await protocol.report(child, {
        run_id: runId,
        status: "done",
        summary: "第一次报告",
        artifacts: [artifact.pathname],
        issues: [],
      })
      expect(first).toMatchObject({ ok: true, review: "pending_review" })
      const beforeDuplicate = readHardeningPlan(fixture.root)

      const duplicate = await protocol.report(child, {
        run_id: runId,
        status: "done",
        summary: "不应覆盖的报告",
        artifacts: [artifact.pathname],
        issues: ["duplicate"],
      })
      expect(duplicate).toMatchObject({ ok: true, review: "already_reported" })
      const afterDuplicate = readHardeningPlan(fixture.root)
      expect(afterDuplicate.revision).toBe(beforeDuplicate.revision)
      expect(afterDuplicate.steps[0]?.tasks[0]?.report?.summary).toBe("第一次报告")
      expect(children.calls.create).toBe(1)
    } finally {
      fixture.cleanup()
    }
  })

  it("rejects Reports for terminal tasks instead of accepting a stale run", async () => {
    const fixture = createHardeningWorkspace()
    try {
      const outputPath = path.join(fixture.root, "output")
      const artifact = createFakeArtifact(path.join(outputPath, "report.md"))
      artifact.write()
      const protocol = new PlanProtocol({ store: new PlanStore(), children: createHardeningChildren().controller })
      const root = hardeningContext(fixture.root)
      await protocol.create(root, hardeningPlanInput(outputPath))
      const dispatched = await protocol.dispatch(root, { taskIds: ["s1_t1"], role: "general" })
      if (!dispatched.ok) return
      const runId = dispatched.dispatched[0]!.run_id
      const child = { ...hardeningContext(fixture.root, "child_s1_t1", "single"), runId }
      expect(
        await protocol.report(child, {
          run_id: runId,
          status: "done",
          summary: "第一次报告",
          artifacts: [artifact.pathname],
          issues: [],
        }),
      ).toMatchObject({ ok: true })

      const plan = readHardeningPlan(fixture.root)
      plan.steps[0]!.tasks[0]!.status = "approved"
      plan.steps[0]!.tasks[0]!.dispatch!.run_id = "run__ses_main__replacement__s1_t1"
      fs.writeFileSync(planFilePath(fixture.root, "ses_main"), JSON.stringify(plan))

      const stale = await protocol.report(child, {
        run_id: runId,
        status: "done",
        summary: "过期报告",
        artifacts: [artifact.pathname],
        issues: [],
      })
      expect(stale).toMatchObject({ ok: false, error: { code: "RUN_STALE" } })
    } finally {
      fixture.cleanup()
    }
  })

  it("keeps a task running when a Report artifact is outside its output subtree", async () => {
    const fixture = createHardeningWorkspace()
    try {
      const outputPath = path.join(fixture.root, "output")
      const outsideArtifact = path.join(fixture.root, "outside.md")
      fs.writeFileSync(outsideArtifact, "outside")
      const protocol = new PlanProtocol({ store: new PlanStore(), children: createHardeningChildren().controller })
      const root = hardeningContext(fixture.root)
      await protocol.create(root, hardeningPlanInput(outputPath))
      const dispatched = await protocol.dispatch(root, { taskIds: ["s1_t1"], role: "general" })
      if (!dispatched.ok) return
      const runId = dispatched.dispatched[0]!.run_id
      const report = await protocol.report(
        { ...hardeningContext(fixture.root, "child_s1_t1", "single"), runId },
        { run_id: runId, status: "done", summary: "越界产物", artifacts: [outsideArtifact], issues: [] },
      )
      expect(report).toMatchObject({ ok: false })
      expect(readHardeningPlan(fixture.root).steps[0]?.tasks[0]?.status).toBe("running")
    } finally {
      fixture.cleanup()
    }
  })

  it("does not leave a task running when child start fails", async () => {
    const fixture = createHardeningWorkspace()
    try {
      const children = createHardeningChildren({ startFailures: 1 })
      const protocol = new PlanProtocol({ store: new PlanStore(), children: children.controller })
      const root = hardeningContext(fixture.root)
      await protocol.create(root, hardeningPlanInput(path.join(fixture.root, "output")))
      const dispatched = await protocol.dispatch(root, { taskIds: ["s1_t1"], role: "general" })
      expect(dispatched).toMatchObject({ ok: false })
      expect(readHardeningPlan(fixture.root).steps[0]?.tasks[0]?.status).not.toBe("running")
      expect(children.calls.create).toBe(1)
      expect(children.calls.start).toBe(1)
    } finally {
      fixture.cleanup()
    }
  })

  it("requires a fresh Blackboard read before Report without changing report retry state", async () => {
    const root = workspace()
    const artifact = path.join(root, "report.md")
    fs.writeFileSync(artifact, "ready")
    let blackboardReady = false
    let gateCalls = 0
    const children = createHardeningChildren()
    const protocol = new PlanProtocol({
      children: children.controller,
      beforeReport: async () => {
        gateCalls++
        if (!blackboardReady)
          throw new PlanProtocolError({
            code: "BLACKBOARD_UNREAD",
            message: "Report 前必须读取 Blackboard",
            hint: "先无参调用 Blackboard 后重试",
            retryable: true,
          })
      },
    })
    await protocol.create(context(root), createInput(artifact))
    const dispatched = await protocol.dispatch(context(root), { taskIds: ["s1_t1"], role: "general" })
    expect(dispatched.ok).toBe(true)
    if (!dispatched.ok) return
    const runId = dispatched.dispatched[0]!.run_id
    const childContext = { ...context(root, "single", "child_blackboard"), runId }
    const rejected = await protocol.report(childContext, {
      run_id: runId,
      status: "done",
      summary: "ready",
      artifacts: [artifact],
      issues: [],
    })
    expect(rejected).toMatchObject({ ok: false, error: { code: "BLACKBOARD_UNREAD", retryable: true } })
    const unchanged = await protocol.read(context(root))
    if (!unchanged.ok || !unchanged.plan) return
    expect(unchanged.plan.revision).toBe(2)
    expect(unchanged.plan.steps[0]?.tasks[0]?.status).toBe("running")

    blackboardReady = true
    const accepted = await protocol.report(childContext, {
      run_id: runId,
      status: "done",
      summary: "ready",
      artifacts: [artifact],
      issues: [],
    })
    expect(accepted).toMatchObject({ ok: true, review: "pending_review" })
    expect(gateCalls).toBe(2)
  })

  it("does not advance a Step until the root has handled current Blackboard work", async () => {
    const root = workspace()
    const artifact = path.join(root, "blackboard-gated.md")
    fs.writeFileSync(artifact, "ready")
    let blackboardClear = false
    let gateCalls = 0
    const children = createHardeningChildren()
    const protocol = new PlanProtocol({
      children: children.controller,
      beforeStepAdvance: async () => {
        gateCalls++
        if (!blackboardClear)
          throw new PlanProtocolError({
            code: "BLACKBOARD_UNREAD",
            message: "Read Blackboard before advancing the Step",
            hint: "Call Blackboard and retry the same revision",
            retryable: true,
          })
      },
    })
    await protocol.create(context(root), createInput(artifact))
    const dispatched = await protocol.dispatch(context(root), { taskIds: ["s1_t1"], role: "general" })
    expect(dispatched.ok).toBe(true)
    if (!dispatched.ok) return
    const reported = await protocol.report(
      { ...context(root, "single", "child_blackboard_gate"), runId: dispatched.dispatched[0]!.run_id },
      {
        run_id: dispatched.dispatched[0]!.run_id,
        status: "done",
        summary: "ready",
        artifacts: [artifact],
        issues: [],
      },
    )
    expect(reported.ok).toBe(true)
    const blocked = await protocol.update(context(root), {
      revision: 3,
      ops: [{ op: "review_task", stepId: "s1", taskId: "s1_t1", decision: "approve" }],
    })
    expect(blocked).toMatchObject({ ok: false, error: { code: "BLACKBOARD_UNREAD", retryable: true } })
    const unchanged = await protocol.read(context(root))
    expect(unchanged).toMatchObject({ ok: true, plan: { revision: 3, current_step: "s1" } })

    blackboardClear = true
    const advanced = await protocol.update(context(root), {
      revision: 3,
      ops: [{ op: "review_task", stepId: "s1", taskId: "s1_t1", decision: "approve" }],
    })
    expect(advanced.ok).toBe(true)
    const after = await protocol.read(context(root))
    expect(after).toMatchObject({ ok: true, plan: { revision: 4, current_step: "s2" } })
    expect(gateCalls).toBe(2)
  })

  it("lets a completed plan resume with add_step without the step-advance gate", async () => {
    const root = workspace()
    let gateCalls = 0
    let gateEnabled = false
    const protocol = new PlanProtocol({
      beforeStepAdvance: async () => {
        gateCalls++
        if (gateEnabled)
          throw new PlanProtocolError({
            code: "BLACKBOARD_UNREAD",
            message: "gate should not run for a fresh wave",
            hint: "none",
            retryable: true,
          })
      },
    })
    await protocol.create(context(root, "single"), createInput())
    await protocol.update(context(root, "single"), {
      revision: 1,
      ops: [
        { op: "set_task_status", stepId: "s1", taskId: "s1_t1", to: "running" },
        { op: "set_task_status", stepId: "s1", taskId: "s1_t1", to: "reported" },
        { op: "set_task_status", stepId: "s1", taskId: "s1_t1", to: "approved" },
      ],
    })
    await protocol.update(context(root, "single"), {
      revision: 2,
      ops: [{ op: "add_task", stepId: "s2", task: { title: "实现", goal: "实现", done_criteria: "通过测试" } }],
    })
    await protocol.update(context(root, "single"), {
      revision: 3,
      ops: [
        { op: "set_task_status", stepId: "s2", taskId: "s2_t1", to: "running" },
        { op: "set_task_status", stepId: "s2", taskId: "s2_t1", to: "reported" },
        { op: "set_task_status", stepId: "s2", taskId: "s2_t1", to: "approved" },
      ],
    })
    const done = await protocol.read(context(root, "single"))
    if (!done.ok || !done.plan) return
    expect(done.plan).toMatchObject({ status: "done", current_step: null })
    expect(gateCalls).toBe(2)

    gateEnabled = true
    const resumed = await protocol.update(context(root, "single"), {
      revision: 4,
      ops: [{ op: "add_step", step: { title: "追加", goal: "追加", done_criteria: "完成" } }],
    })
    expect(resumed).toMatchObject({ ok: true, assigned_ids: { steps: ["s3"] } })
    const after = await protocol.read(context(root, "single"))
    expect(after).toMatchObject({ ok: true, plan: { status: "active", current_step: "s3" } })
    expect(gateCalls).toBe(2)

    const withTask = await protocol.update(context(root, "single"), {
      revision: 5,
      ops: [{ op: "add_task", stepId: "s3", task: { title: "新任务", goal: "新任务", done_criteria: "完成" } }],
    })
    expect(withTask).toMatchObject({ ok: true, assigned_ids: { tasks: ["s3_t1"] } })
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
    expect(planSystemPrompt({ child: true, multiAgent: true })).toContain("Blackboard")
    const multiAgentPrompt = planSystemPrompt({
      child: false,
      multiAgent: true,
      profiles: [
        defaultGeneralProfile,
        {
          id: "reviewer",
          name: "Reviewer",
          description: "Checks delegated work.",
          prompt: "",
          avatar: "bug",
          enabled: true,
        },
      ],
    })
    expect(multiAgentPrompt).toContain("Dispatch_dispatch")
    expect(multiAgentPrompt).toContain("Dispatch_roles")
    expect(multiAgentPrompt).toContain("Candidate_declare")
    expect(multiAgentPrompt).toContain('mode: "candidate"')
    expect(multiAgentPrompt).toContain("candidate_discussion")
    expect(multiAgentPrompt).toContain("Dispatch_dispatch exactly once")
    expect(multiAgentPrompt).toContain("Plan_update(add_task) cannot extend")
    expect(multiAgentPrompt).toContain("ordinary parallel")
    expect(multiAgentPrompt).toContain("candidate parallel")
    expect(multiAgentPrompt).toContain("single Task")
    expect(multiAgentPrompt).toContain("Blackboard is the shared coordination channel")
    expect(multiAgentPrompt).not.toMatch(/\b(?:Plan|Dispatch|Candidate)\./)
    expect(multiAgentPrompt).toContain("output_path")
    expect(multiAgentPrompt).toContain("reviewer")
    expect(planSystemPrompt({ child: false, multiAgent: true, profiles: [] })).toContain("No enabled sub-agent roles")
    expect(multiAgentPrompt).not.toContain("互不冲突")
    expect(planSystemPrompt({ child: false, multiAgent: false })).toContain("pending→running")
    const childPrompt = planSystemPrompt({ child: true, multiAgent: true })
    expect(childPrompt).toContain("read Blackboard at the start")
    expect(childPrompt).toContain("publish a concise finding or handoff")
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

  it("settles a dead child run back to rejected instead of leaving it running", async () => {
    const root = workspace()
    const protocol = new PlanProtocol({
      store: new PlanStore(),
      children: {
        async create(input) {
          return input.childSessionId
        },
        async start() {},
        async terminate() {},
      },
    })
    await protocol.create(context(root), createInput(path.join(root, "notes.md")))
    const dispatched = await protocol.dispatch(context(root), { taskIds: ["s1_t1"], role: "general" })
    expect(dispatched.ok).toBe(true)
    if (!dispatched.ok) return
    const runId = dispatched.dispatched[0]!.run_id
    const childSessionId = dispatched.dispatched[0]!.child_session_id
    const settle = () =>
      protocol.settleChildExit({
        workspaceRoot: root,
        parentSessionId: "ses_main",
        childSessionId,
        taskId: "s1_t1",
        runId,
      })

    const stale = await protocol.settleChildExit({
      workspaceRoot: root,
      parentSessionId: "ses_main",
      childSessionId,
      taskId: "s1_t1",
      runId: "run__ses_main__s1_t2",
    })
    expect(stale).toEqual({ settled: false, reason: "stale_run" })

    expect(await settle()).toEqual({ settled: true, reason: "child_exited" })
    const read = await protocol.read(context(root))
    if (!read.ok || !read.plan) return
    expect(read.plan.steps[0]?.tasks[0]?.status).toBe("rejected")
    expect(read.plan.steps[0]?.status).toBe("active")

    // Idempotent: a second settle for the same run changes nothing.
    expect(await settle()).toEqual({ settled: false, reason: "already_settled" })

    // The main agent is unblocked and can redispatch the task right away.
    const retried = await protocol.dispatch(context(root), { taskIds: ["s1_t1"], role: "general" })
    expect(retried.ok).toBe(true)
    if (!retried.ok) return
    expect(retried.dispatched[0]?.idempotent).toBe(false)
    expect(retried.dispatched[0]?.run_id).toBe(runId)
  })

  it("does not settle cancelled or reported runs", async () => {
    const root = workspace()
    const artifact = path.join(root, "notes.md")
    fs.writeFileSync(artifact, "done")
    const protocol = new PlanProtocol({
      store: new PlanStore(),
      children: {
        async create(input) {
          return input.childSessionId
        },
        async start() {},
        async terminate() {},
      },
    })
    await protocol.create(context(root), createInput(artifact))
    const dispatched = await protocol.dispatch(context(root), { taskIds: ["s1_t1"], role: "general" })
    expect(dispatched.ok).toBe(true)
    if (!dispatched.ok) return
    const runId = dispatched.dispatched[0]!.run_id
    const childSessionId = dispatched.dispatched[0]!.child_session_id
    const settle = () =>
      protocol.settleChildExit({
        workspaceRoot: root,
        parentSessionId: "ses_main",
        childSessionId,
        taskId: "s1_t1",
        runId,
      })

    const report = await protocol.report(
      { ...context(root, "single", childSessionId), runId },
      { run_id: runId, status: "done", summary: "完成", artifacts: [artifact], issues: [] },
    )
    expect(report.ok).toBe(true)
    expect(await settle()).toEqual({ settled: false, reason: "already_settled" })
    const read = await protocol.read(context(root))
    if (!read.ok || !read.plan) return
    expect(read.plan.steps[0]?.tasks[0]?.status).toBe("reported")

    expect((await protocol.cancel(context(root), ["s1_t1"])).ok).toBe(true)
    expect(await settle()).toEqual({ settled: false, reason: "cancelled" })
  })

  it("keeps candidate children waiting on discussion checkpoints running", async () => {
    const root = workspace()
    const now = new Date().toISOString()
    const candidate = (id: string) => ({
      id,
      title: id,
      goal: "g",
      done_criteria: "d",
      output_path: null,
      mode: "candidate",
      status: "running",
      dispatch: {
        run_id: `run__ses_main__${id}`,
        child_session_id: `child_ses_main_${id}`,
        dispatched_at: now,
        cancelled_at: null,
      },
      report: null,
    })
    const planPath = planFilePath(root, "ses_main")
    fs.mkdirSync(path.dirname(planPath), { recursive: true })
    const plan = {
      title: "c",
      goal: "g",
      status: "active",
      revision: 1,
      current_step: "s1",
      steps: [
        {
          id: "s1",
          title: "t",
          goal: "g",
          done_criteria: "d",
          status: "active",
          candidate_discussion: { phase: "declaring", ready_task_ids: [] },
          tasks: [candidate("s1_t1"), candidate("s1_t2")],
        },
      ],
      created_at: now,
      updated_at: now,
    }
    fs.writeFileSync(planPath, JSON.stringify(plan))
    const protocol = new PlanProtocol({ store: new PlanStore() })
    const settle = () =>
      protocol.settleChildExit({
        workspaceRoot: root,
        parentSessionId: "ses_main",
        childSessionId: "child_ses_main_s1_t1",
        taskId: "s1_t1",
        runId: "run__ses_main__s1_t1",
      })

    // A candidate that ends its turn during declaring/cross_review is waiting
    // for a checkpoint wakeup, not dead.
    expect(await settle()).toEqual({ settled: false, reason: "candidate_waiting" })

    // Once independent execution starts, exiting without Candidate_submit
    // means the child is dead and must not stay running.
    const running = JSON.parse(fs.readFileSync(planPath, "utf8"))
    running.steps[0].candidate_discussion.phase = "running"
    fs.writeFileSync(planPath, JSON.stringify(running))
    expect(await settle()).toEqual({ settled: true, reason: "child_exited" })
    const settled = JSON.parse(fs.readFileSync(planPath, "utf8"))
    expect(settled.steps[0].tasks[0].status).toBe("rejected")
    expect(settled.steps[0].tasks[1].status).toBe("running")
  })
})
