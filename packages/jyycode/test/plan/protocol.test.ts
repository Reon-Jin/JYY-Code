import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { describe, expect, it } from "bun:test"
import { PlanProtocol, type ChildStartInput } from "../../src/plan/protocol"
import { PlanEventHub, PlanInbox, WakeupQueue, validatePlanEvent } from "../../src/plan/events"
import { AGING_MS, PlanStore, STALE_LOCK_MS, type WriteRequest } from "../../src/plan/store"
import {
  isStepComplete,
  normalizePlanFile,
  planFilePath,
  PlanProtocolError,
  validatePlanFile,
  type PlanFile,
} from "../../src/plan/schema"
import { projectPlanSnapshot, validatePlanSnapshot } from "../../src/plan/snapshot"
import { planSystemPrompt } from "../../src/plan/prompts"
import { defaultGeneralProfile } from "../../src/agent/subagent-profile"
import { ChildWorkspace } from "../../src/plan/child-workspace"
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

type MergeProtocol = PlanProtocol & {
  merge(
    context: { workspaceRoot: string; sessionId: string; mode: "single" | "multi" },
    input: { task_id: string; paths?: string[]; resolutions?: Array<{ path: string; use: "main" | "child" }> },
  ): Promise<unknown>
}

function mergeApply(protocol: PlanProtocol, root: string, input: Parameters<MergeProtocol["merge"]>[1]) {
  return (protocol as MergeProtocol).merge(context(root), input)
}

class FailingPlanStore extends PlanStore {
  failWrites = false

  override enqueueWrite<T>(planPath: string, request: WriteRequest<T>): Promise<T> {
    if (this.failWrites) return Promise.reject(new Error("reservation write failed"))
    return super.enqueueWrite(planPath, request)
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

  it("rejects nested dispatch at the protocol boundary while allowing root dispatch", async () => {
    const root = workspace()
    let createdDepth: number | undefined
    const protocol = new PlanProtocol({
      children: {
        async create(input) {
          createdDepth = input.agentDepth
          return input.childSessionId
        },
        async start() {},
        async terminate() {},
      },
    })
    await protocol.create(context(root), createInput(path.join(root, "notes.md")))

    const nested = await protocol.dispatch({ ...context(root), agentDepth: 1 }, { taskIds: ["s1_t1"], role: "general" })
    expect(nested).toMatchObject({ ok: false, error: { code: "DISPATCH_UNAVAILABLE" } })
    expect(createdDepth).toBeUndefined()

    const rootDispatch = await protocol.dispatch(context(root), { taskIds: ["s1_t1"], role: "general" })
    expect(rootDispatch).toMatchObject({ ok: true })
    expect(createdDepth).toBe(1)
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

  it("does not terminate a child session before workspace preparation creates it", async () => {
    const root = workspace()
    const missingProjectRoot = path.join(root, "missing-project")
    let creates = 0
    let terminations = 0
    const protocol = new PlanProtocol({
      store: new PlanStore(),
      childWorkspace: new ChildWorkspace({
        project: { root: missingProjectRoot, vcs: "none" },
        runtimeRoot: path.join(root, "runtime"),
      }),
      children: {
        async create() {
          creates++
          return "ses_child"
        },
        async start() {},
        async terminate() {
          terminations++
        },
      },
    })
    await protocol.create(context(root), createInput(path.join(root, "notes.md")))

    const dispatched = await protocol.dispatch(context(root), { taskIds: ["s1_t1"], role: "general" })
    expect(dispatched).toMatchObject({
      ok: false,
      error: { code: "SCHEMA_VALIDATION", message: expect.stringContaining("ENOENT") },
    })
    expect(creates).toBe(0)
    expect(terminations).toBe(0)

    const read = await protocol.read(context(root))
    if (!read.ok || !read.plan) return
    expect(read.plan.steps[0]?.tasks[0]?.status).toBe("rejected")
  })

  it("starts every task in a dispatch wave concurrently", async () => {
    const root = workspace()
    const input = createInput(path.join("out", "one.md"))
    input.steps[0]!.tasks!.push({
      title: "Check API",
      goal: "Check the API request shape",
      done_criteria: "API check file exists",
      output_path: path.join("out", "two.md"),
    })
    let releaseFirst!: () => void
    const firstRelease = new Promise<void>((resolve) => {
      releaseFirst = resolve
    })
    let firstStarted!: () => void
    const firstStartedSignal = new Promise<void>((resolve) => {
      firstStarted = resolve
    })
    let secondStarted!: () => void
    const secondStartedSignal = new Promise<void>((resolve) => {
      secondStarted = resolve
    })
    const started: string[] = []
    const protocol = new PlanProtocol({
      store: new PlanStore(),
      profiles: async () => [defaultGeneralProfile],
      children: {
        async create(input) {
          return `ses_${input.taskId}`
        },
        async start(input) {
          started.push(input.taskId)
          if (input.taskId === "s1_t1") {
            firstStarted()
            await firstRelease
            return
          }
          secondStarted()
        },
        async terminate() {},
      },
    })
    await protocol.create(context(root), input)

    const dispatching = protocol.dispatch(context(root), { taskIds: ["s1_t1", "s1_t2"], role: "general" })
    await firstStartedSignal
    const secondStartedBeforeFirstFinished = await Promise.race([
      secondStartedSignal.then(() => true),
      new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 50)),
    ])
    expect(secondStartedBeforeFirstFinished).toBe(true)
    releaseFirst()

    expect(await dispatching).toMatchObject({
      ok: true,
      dispatched: [
        { taskId: "s1_t1", idempotent: false },
        { taskId: "s1_t2", idempotent: false },
      ],
    })
    expect(started).toEqual(["s1_t1", "s1_t2"])
    const read = await protocol.read(context(root))
    if (!read.ok || !read.plan) return
    expect(read.plan.steps[0]?.tasks.map((task) => task.status)).toEqual(["running", "running"])
  })

  it("cancels running and already-cancelled dispatches idempotently", async () => {
    const root = workspace()
    let terminations = 0
    const protocol = new PlanProtocol({
      store: new PlanStore(),
      inbox: new PlanInbox(),
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

    expect(await protocol.cancel(context(root), ["s1_t1"])).toMatchObject({
      ok: true,
      next_action_hint: expect.stringContaining("pending"),
    })
    expect(await protocol.cancel(context(root), ["s1_t1"])).toMatchObject({ ok: true })
    expect(terminations).toBe(1)

    const read = await protocol.read(context(root))
    if (!read.ok || !read.plan) return
    expect(read.plan.steps[0]?.tasks[0]?.status).toBe("pending")
    expect(read.plan.steps[0]?.tasks[0]?.dispatch?.cancelled_at).not.toBeNull()
  })

  it("rejects cancelling reported, approved, and dismissed tasks", async () => {
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

    for (const status of ["reported", "approved", "dismissed"] as const) {
      const stored = JSON.parse(fs.readFileSync(planFilePath(root, "ses_main"), "utf8")) as {
        steps: Array<{ tasks: Array<{ status: string; dispatch: { cancelled_at: string | null } }> }>
      }
      stored.steps[0]!.tasks[0]!.status = status
      stored.steps[0]!.tasks[0]!.dispatch.cancelled_at = null
      fs.writeFileSync(planFilePath(root, "ses_main"), JSON.stringify(stored))

      expect(await protocol.cancel(context(root), ["s1_t1"])).toMatchObject({
        ok: false,
        error: { code: "INVALID_STATE", hint: expect.stringContaining("reopen_task") },
      })
      const after = JSON.parse(fs.readFileSync(planFilePath(root, "ses_main"), "utf8")) as {
        steps: Array<{ tasks: Array<{ status: string }> }>
      }
      expect(after.steps[0]?.tasks[0]?.status).toBe(status)
    }
    expect(terminations).toBe(0)
  })

  it("reopens a terminal task only through an explicit reasoned operation", async () => {
    const root = workspace()
    const protocol = new PlanProtocol({ store: new PlanStore() })
    await protocol.create(context(root), createInput(path.join(root, "notes.md")))
    const dispatched = await protocol.dispatch(context(root), { taskIds: ["s1_t1"], role: "general" })
    expect(dispatched.ok).toBe(true)
    const stored = JSON.parse(fs.readFileSync(planFilePath(root, "ses_main"), "utf8")) as {
      revision: number
      steps: Array<{ tasks: Array<{ status: string; dispatch: unknown; report: unknown }> }>
    }
    stored.steps[0]!.tasks[0]!.status = "approved"
    stored.steps[0]!.tasks[0]!.report = {
      status: "done",
      summary: "old",
      artifacts: [],
      issues: [],
      reported_at: new Date().toISOString(),
      review_feedback: null,
    }
    fs.writeFileSync(planFilePath(root, "ses_main"), JSON.stringify(stored))

    const reopened = await protocol.update(context(root), {
      revision: stored.revision,
      ops: [{ op: "reopen_task", stepId: "s1", taskId: "s1_t1", reason: "验收标准已更新，需要重新执行" }],
    })
    expect(reopened).toMatchObject({ ok: true })
    const read = await protocol.read(context(root))
    if (!read.ok || !read.plan) return
    expect(read.plan.steps[0]?.tasks[0]).toMatchObject({
      status: "pending",
      dispatch: null,
      report: null,
      reopen_reason: "验收标准已更新，需要重新执行",
    })
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

  it("repairs an output_path escaping the workspace at create time", async () => {
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
    expect(createdPlan.ok).toBe(true)
    if (!createdPlan.ok) return
    expect(createdPlan.warnings).toEqual([expect.stringContaining("已重置为 artifacts/escape.md")])
    expect(created).toBe(false)
    expect(fs.existsSync(planFilePath(root, "ses_main"))).toBe(true)
  })

  it("repairs an output_path with a stray drive prefix at create time", async () => {
    const root = workspace()
    const protocol = new PlanProtocol({ store: new PlanStore() })
    const result = await protocol.create(context(root), createInput(`c:/${root.replace(/\\/g, "/")}/notes.md`))
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.warnings).toEqual([expect.stringContaining("已重置为 artifacts/notes.md")])
    const read = await protocol.read(context(root))
    expect(read.ok).toBe(true)
    if (!read.ok) return
    expect(read.plan?.steps[0]?.tasks[0]?.output_path).toBe("artifacts/notes.md")
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

  it("keeps tasks on later create steps and rejects duplicate plans", async () => {
    const root = workspace()
    const protocol = new PlanProtocol({ store: new PlanStore() })
    const kept = await protocol.create(context(root), {
      ...createInput(),
      steps: [
        { ...createInput().steps[0] },
        { ...createInput().steps[1], tasks: [{ title: "x", goal: "x", done_criteria: "x" }] },
      ],
    })
    expect(kept.ok).toBe(true)
    if (!kept.ok) return
    expect(kept.plan_id_assigned.tasks["s2"]).toEqual(["s2_t1"])
    const read = await protocol.read(context(root))
    expect(read.ok).toBe(true)
    if (!read.ok) return
    expect(read.plan?.steps[1]?.tasks).toHaveLength(1)
    const duplicate = await protocol.create(context(root), createInput())
    expect(duplicate.ok).toBe(false)
    if (!duplicate.ok) expect(duplicate.error.hint).toContain("Plan_update")
  })

  it("ignores unrecognized create fields and reports them as warnings", async () => {
    const root = workspace()
    const protocol = new PlanProtocol({ store: new PlanStore() })
    const forged = await protocol.create(context(root), { ...createInput(), priority: "high" })
    expect(forged.ok).toBe(true)
    if (!forged.ok) return
    expect(forged.warnings).toEqual(["忽略未识别字段 create.priority"])
    const read = await protocol.read(context(root))
    expect(read.ok).toBe(true)
    if (!read.ok) return
    expect(read.plan?.title).toBe("重构用户模块")
  })

  it("derives missing titles from goals instead of rejecting the plan", async () => {
    const root = workspace()
    const protocol = new PlanProtocol({ store: new PlanStore() })
    const result = await protocol.create(context(root), {
      goal: "完成中美 AI 现状对比",
      steps: [
        {
          goal: "搜集资料",
          done_criteria: "资料齐全",
          tasks: [{ goal: "检索公开数据", done_criteria: "数据存在", output_path: "research.md" }],
        },
        { goal: "制作 PPT", done_criteria: "三页 PPT 已生成" },
      ],
    })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.warnings).toEqual(
      expect.arrayContaining([
        "title 缺失或为空，已自动补充：完成中美 AI 现状对比",
        "steps[0].title 缺失或为空，已自动补充：搜集资料",
        "steps[0].tasks[0].title 缺失或为空，已自动补充：检索公开数据",
        "steps[1].title 缺失或为空，已自动补充：制作 PPT",
      ]),
    )
    const read = await protocol.read(context(root))
    expect(read.ok).toBe(true)
    if (!read.ok) return
    expect(read.plan?.title).toBe("完成中美 AI 现状对比")
    expect(read.plan?.steps[0]?.tasks[0]?.title).toBe("检索公开数据")
  })

  it("ignores caller-supplied child execution limits in create and rejects them in update inputs", async () => {
    const root = workspace()
    const protocol = new PlanProtocol({ store: new PlanStore() })
    const forgedCreate = {
      ...createInput(),
      steps: [
        {
          ...createInput().steps[0],
          tasks: [{ ...createInput().steps[0]!.tasks![0], timeout_ms: 900_000, max_steps: 1 }],
        },
        createInput().steps[1],
      ],
    }
    const createResult = await protocol.create(context(root), forgedCreate as never)
    expect(createResult.ok).toBe(true)
    if (!createResult.ok) return
    expect(createResult.warnings).toEqual([
      "忽略未识别字段 steps[0].tasks[0].timeout_ms",
      "忽略未识别字段 steps[0].tasks[0].max_steps",
    ])
    const created = await protocol.read(context(root))
    expect(created.ok).toBe(true)
    if (!created.ok) return
    expect(JSON.stringify(created.plan)).not.toContain("timeout_ms")
    expect(JSON.stringify(created.plan)).not.toContain("max_steps")

    const updateResult = await protocol.update(context(root), {
      revision: 1,
      ops: [
        {
          op: "edit_task",
          stepId: "s1",
          taskId: "s1_t1",
          fields: { timeout_ms: 900_000, max_steps: 1 },
        },
      ],
    } as never)
    expect(updateResult.ok).toBe(false)
    if (!updateResult.ok) expect(updateResult.error.code).toBe("SCHEMA_VALIDATION")
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
    // The task is reportable before the child starts so an immediate Report
    // cannot race the lifecycle transition.
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
    expect(review).toMatchObject({
      ok: true,
      reviewed: [{ taskId: "s1_t1", result: "rejected" }],
      dispatched: [{ taskId: "s1_t1", idempotent: false }],
    })
    expect((brief as { previous_feedback?: { review_feedback: string } }).previous_feedback?.review_feedback).toContain(
      "tests/",
    )
    const retried = await protocol.read(context(root))
    if (!retried.ok || !retried.plan) return
    expect(retried.plan.steps[0]?.tasks[0]?.status).toBe("running")
    const metrics = events
      .readAfter("ses_main", -1)
      .filter((event) => event.type === "runtime.metric")
      .map((event) => event.payload)
    expect(metrics.some((payload) => payload.metric === "dispatch" && payload.phase === "start")).toBe(true)
    expect(metrics.some((payload) => payload.metric === "report" && payload.phase === "submit")).toBe(true)
  })

  it("automatically retries every rejected task in the same dispatch wave", async () => {
    const root = workspace()
    const firstArtifact = path.join(root, "one.md")
    const secondArtifact = path.join(root, "two.md")
    const input = createInput(firstArtifact)
    input.steps[0]!.tasks!.push({
      title: "Validate the second output",
      goal: "Create the second output",
      done_criteria: "two.md exists",
      output_path: secondArtifact,
    })
    const starts: ChildStartInput[] = []
    const protocol = new PlanProtocol({
      store: new PlanStore(),
      inbox: new PlanInbox(),
      children: {
        async create(input) {
          return input.childSessionId
        },
        async start(input) {
          starts.push(input)
        },
        async terminate() {},
      },
    })
    await protocol.create(context(root), input)
    const initial = await protocol.dispatch(context(root), { taskIds: ["s1_t1", "s1_t2"], role: "general" })
    expect(initial.ok).toBe(true)
    if (!initial.ok) return

    for (const [taskId, artifact] of [
      ["s1_t1", firstArtifact],
      ["s1_t2", secondArtifact],
    ] as const) {
      const runId = initial.dispatched.find((item) => item.taskId === taskId)!.run_id
      const childSessionId = initial.dispatched.find((item) => item.taskId === taskId)!.child_session_id
      fs.writeFileSync(artifact, "123")
      const report = await protocol.report(
        { ...context(root, "single", childSessionId), runId },
        { run_id: runId, status: "done", summary: "created", artifacts: [artifact], issues: [] },
      )
      expect(report.ok).toBe(true)
    }

    const pendingReview = await protocol.read(context(root))
    if (!pendingReview.ok || !pendingReview.plan) return
    const retried = await protocol.update(context(root), {
      revision: pendingReview.plan.revision,
      ops: [
        { op: "review_task", stepId: "s1", taskId: "s1_t1", decision: "reject", feedback: "追加 abc" },
        { op: "review_task", stepId: "s1", taskId: "s1_t2", decision: "reject", feedback: "追加 abc" },
      ],
    })

    expect(retried).toMatchObject({
      ok: true,
      dispatched: [
        { taskId: "s1_t1", idempotent: false },
        { taskId: "s1_t2", idempotent: false },
      ],
    })
    expect(starts).toHaveLength(4)
    expect(starts.slice(-2).every((start) => start.brief.previous_feedback?.review_feedback === "追加 abc")).toBe(true)
  })

  it("keeps review approval separate from parent integration", async () => {
    const root = workspace()
    const runtime = fs.mkdtempSync(path.join(os.tmpdir(), "jyycode-review-runtime-"))
    const parentFile = path.join(root, "src", "parent.ts")
    fs.mkdirSync(path.dirname(parentFile), { recursive: true })
    fs.writeFileSync(parentFile, "parent content\n")
    let childOutput = ""
    try {
      const protocol = new PlanProtocol({
        childWorkspace: new ChildWorkspace({ project: { root, vcs: "none" }, runtimeRoot: runtime }),
        children: {
          async create(input) {
            childOutput = input.brief.output_path
            return input.childSessionId
          },
          async start() {},
          async terminate() {},
        },
      })
      await protocol.create(context(root), createInput("out/result.md"))
      const dispatched = await protocol.dispatch(context(root), { taskIds: ["s1_t1"], role: "general" })
      expect(dispatched.ok).toBe(true)
      if (!dispatched.ok) return
      fs.mkdirSync(path.dirname(childOutput), { recursive: true })
      fs.writeFileSync(childOutput, "report\n")
      const runId = dispatched.dispatched[0]!.run_id
      const reported = await protocol.report(
        { workspaceRoot: path.dirname(path.dirname(childOutput)), sessionId: "child_s1_t1", mode: "single", runId },
        { run_id: runId, status: "done", summary: "ready", artifacts: [childOutput], issues: [] },
      )
      expect(reported).toMatchObject({ ok: true, review: "pending_review" })
      const before = await protocol.read(context(root))
      if (!before.ok || !before.plan) return
      const approved = await protocol.update(context(root), {
        revision: before.plan.revision,
        ops: [{ op: "review_task", stepId: "s1", taskId: "s1_t1", decision: "approve" }],
      })
      expect(approved).toMatchObject({ ok: true })
      expect(fs.readFileSync(parentFile, "utf8")).toBe("parent content\n")
      const after = await protocol.read(context(root))
      expect(after).toMatchObject({ ok: true, plan: { current_step: "s1" } })
    } finally {
      fs.rmSync(runtime, { recursive: true, force: true })
    }
  })

  it("accepts the minimal Merge.apply input and rejects tasks that are not approved", async () => {
    const root = workspace()
    const protocol = new PlanProtocol({ children: createHardeningChildren().controller })
    await protocol.create(context(root), createInput(path.join(root, "out")))

    const pending = await mergeApply(protocol, root, { task_id: "s1_t1" })
    expect(pending).toMatchObject({ ok: false, error: { code: expect.any(String) } })

    const planPath = planFilePath(root, "ses_main")
    const stored = JSON.parse(fs.readFileSync(planPath, "utf8"))
    for (const status of ["rejected", "dismissed"] as const) {
      stored.steps[0].tasks[0].status = status
      fs.writeFileSync(planPath, JSON.stringify(stored))
      const result = await mergeApply(protocol, root, { task_id: "s1_t1" })
      expect(result).toMatchObject({ ok: false, error: { code: expect.any(String) } })
    }
  })

  it("merges an approved isolated task only after review and cleans child artifacts after durable success", async () => {
    const root = workspace()
    const runtime = fs.mkdtempSync(path.join(os.tmpdir(), "jyycode-merge-runtime-"))
    let childRoot = ""
    let childOutput = ""
    try {
      const protocol = new PlanProtocol({
        childWorkspace: new ChildWorkspace({ project: { root, vcs: "none" }, runtimeRoot: runtime }),
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
      await protocol.create(context(root), createInput("out/result.md"))
      const dispatched = await protocol.dispatch(context(root), { taskIds: ["s1_t1"], role: "general" })
      expect(dispatched).toMatchObject({ ok: true })
      if (!dispatched.ok) return
      fs.mkdirSync(path.dirname(childOutput), { recursive: true })
      fs.writeFileSync(childOutput, "report\n")
      fs.mkdirSync(path.join(childRoot, "src"), { recursive: true })
      fs.writeFileSync(path.join(childRoot, "src", "merged.ts"), "export const merged = true\n")
      const runId = dispatched.dispatched[0]!.run_id
      expect(
        await protocol.report(
          { workspaceRoot: childRoot, sessionId: "child_s1_t1", mode: "single", runId },
          { run_id: runId, status: "done", summary: "ready", artifacts: [childOutput], issues: [] },
        ),
      ).toMatchObject({ ok: true, review: "pending_review" })
      const before = await protocol.read(context(root))
      if (!before.ok || !before.plan) return
      expect(
        await protocol.update(context(root), {
          revision: before.plan.revision,
          ops: [{ op: "review_task", stepId: "s1", taskId: "s1_t1", decision: "approve" }],
        }),
      ).toMatchObject({ ok: true })
      const pending = await protocol.read(context(root))
      if (!pending.ok || !pending.plan) return
      expect(pending.plan.current_step).toBe("s1")
      expect(pending.plan.steps[0]?.tasks[0]?.merge?.status).toBe("pending")

      const merged = await mergeApply(protocol, root, { task_id: "s1_t1" })
      expect(merged).toMatchObject({
        ok: true,
        status: "merged",
        cleanup: "completed",
        applied_paths: expect.arrayContaining(["src/merged.ts"]),
      })
      expect(fs.readFileSync(path.join(root, "src", "merged.ts"), "utf8")).toBe("export const merged = true\n")
      expect(fs.existsSync(childRoot)).toBe(false)
      const afterMerge = await protocol.read(context(root))
      if (afterMerge.ok && afterMerge.plan) {
        const journalDirectory = afterMerge.plan.steps[0]?.tasks[0]?.merge?.journal_directory
        expect(journalDirectory ? fs.existsSync(journalDirectory) : false).toBe(false)
      }
      const after = afterMerge
      expect(after).toMatchObject({ ok: true, plan: { current_step: "s2" } })
      if (after.ok && after.plan) expect(after.plan.steps[0]?.tasks[0]?.merge?.status).toBe("merged")
    } finally {
      fs.rmSync(runtime, { recursive: true, force: true })
    }
  })

  it("applies clean paths before surfacing deduped conflicts and accepts a main resolution", async () => {
    const root = workspace()
    const runtime = fs.mkdtempSync(path.join(os.tmpdir(), "jyycode-merge-conflict-runtime-"))
    let childRoot = ""
    let childOutput = ""
    try {
      fs.mkdirSync(path.join(root, "src"), { recursive: true })
      fs.writeFileSync(path.join(root, "src", "config.ts"), "base\n")
      const events = new PlanEventHub()
      const inbox = new PlanInbox()
      const protocol = new PlanProtocol({
        events,
        inbox,
        childWorkspace: new ChildWorkspace({ project: { root, vcs: "none" }, runtimeRoot: runtime }),
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
      await protocol.create(context(root), createInput("out/result.md"))
      const dispatched = await protocol.dispatch(context(root), { taskIds: ["s1_t1"], role: "general" })
      expect(dispatched).toMatchObject({ ok: true })
      if (!dispatched.ok) return
      fs.mkdirSync(path.dirname(childOutput), { recursive: true })
      fs.writeFileSync(childOutput, "report\n")
      fs.writeFileSync(path.join(childRoot, "src", "config.ts"), "child\n")
      const runId = dispatched.dispatched[0]!.run_id
      await protocol.report(
        { workspaceRoot: childRoot, sessionId: "child_s1_t1", mode: "single", runId },
        { run_id: runId, status: "done", summary: "ready", artifacts: [childOutput], issues: [] },
      )
      const before = await protocol.read(context(root))
      if (!before.ok || !before.plan) return
      await protocol.update(context(root), {
        revision: before.plan.revision,
        ops: [{ op: "review_task", stepId: "s1", taskId: "s1_t1", decision: "approve" }],
      })
      fs.writeFileSync(path.join(root, "src", "config.ts"), "main\n")
      protocol.drainWakeups("ses_main")

      const first = await mergeApply(protocol, root, { task_id: "s1_t1" })
      expect(first).toMatchObject({ ok: true, status: "conflict", applied_paths: ["out/result.md"] })
      expect(fs.readFileSync(path.join(root, "src", "config.ts"), "utf8")).toBe("main\n")
      expect(
        events
          .readAfter("ses_main", -1)
          .filter((event) => event.type === "runtime.metric" && event.payload.metric === "merge")
          .map((event) => event.payload.phase),
      ).toEqual(expect.arrayContaining(["started", "conflict"]))
      expect(protocol.inboxEntries(context(root))).toHaveLength(1)
      expect(protocol.inboxEntries(context(root))[0]).toMatchObject({ kind: "merge_conflict", task_id: "s1_t1" })
      expect(protocol.drainWakeups("ses_main")).toHaveLength(1)

      const repeated = await mergeApply(protocol, root, { task_id: "s1_t1" })
      expect(repeated).toMatchObject({ ok: true, status: "conflict" })
      expect(protocol.inboxEntries(context(root))).toHaveLength(1)
      expect(protocol.drainWakeups("ses_main")).toHaveLength(1)

      const unknown = await mergeApply(protocol, root, {
        task_id: "s1_t1",
        resolutions: [{ path: "missing.ts", use: "main" }],
      })
      expect(unknown).toMatchObject({ ok: false, error: { code: expect.any(String) } })
      expect(fs.readFileSync(path.join(root, "src", "config.ts"), "utf8")).toBe("main\n")

      fs.writeFileSync(path.join(root, "src", "config.ts"), "main-resolved\n")
      const resolved = await mergeApply(protocol, root, {
        task_id: "s1_t1",
        resolutions: [{ path: "src/config.ts", use: "main" }],
      })
      expect(resolved).toMatchObject({ ok: true, status: "merged", cleanup: "completed" })
      expect(fs.readFileSync(path.join(root, "src", "config.ts"), "utf8")).toBe("main-resolved\n")
      expect(fs.existsSync(childRoot)).toBe(false)
      expect(
        events
          .readAfter("ses_main", -1)
          .filter((event) => event.type === "runtime.metric" && event.payload.metric === "merge")
          .some((event) => event.payload.phase === "completed"),
      ).toBe(true)
    } finally {
      fs.rmSync(runtime, { recursive: true, force: true })
      fs.rmSync(root, { recursive: true, force: true })
    }
  })

  it("allows an explicit child resolution to overwrite the parent conflict", async () => {
    const root = workspace()
    const runtime = fs.mkdtempSync(path.join(os.tmpdir(), "jyycode-merge-child-resolution-"))
    let childRoot = ""
    let childOutput = ""
    try {
      fs.mkdirSync(path.join(root, "src"), { recursive: true })
      fs.writeFileSync(path.join(root, "src", "config.ts"), "base\n")
      const inbox = new PlanInbox()
      const protocol = new PlanProtocol({
        inbox,
        childWorkspace: new ChildWorkspace({ project: { root, vcs: "none" }, runtimeRoot: runtime }),
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
      await protocol.create(context(root), createInput("out/result.md"))
      const dispatched = await protocol.dispatch(context(root), { taskIds: ["s1_t1"], role: "general" })
      expect(dispatched).toMatchObject({ ok: true })
      if (!dispatched.ok) return
      fs.mkdirSync(path.dirname(childOutput), { recursive: true })
      fs.writeFileSync(childOutput, "report\n")
      fs.writeFileSync(path.join(childRoot, "src", "config.ts"), "child\n")
      const runId = dispatched.dispatched[0]!.run_id
      await protocol.report(
        { workspaceRoot: childRoot, sessionId: "child_s1_t1", mode: "single", runId },
        { run_id: runId, status: "done", summary: "ready", artifacts: [childOutput], issues: [] },
      )
      const before = await protocol.read(context(root))
      if (!before.ok || !before.plan) return
      await protocol.update(context(root), {
        revision: before.plan.revision,
        ops: [{ op: "review_task", stepId: "s1", taskId: "s1_t1", decision: "approve" }],
      })
      fs.writeFileSync(path.join(root, "src", "config.ts"), "main\n")
      expect(await mergeApply(protocol, root, { task_id: "s1_t1" })).toMatchObject({ ok: true, status: "conflict" })

      const resolved = await mergeApply(protocol, root, {
        task_id: "s1_t1",
        resolutions: [{ path: "src/config.ts", use: "child" }],
      })
      expect(resolved).toMatchObject({ ok: true, status: "merged" })
      expect(fs.readFileSync(path.join(root, "src", "config.ts"), "utf8")).toBe("child\n")
    } finally {
      fs.rmSync(runtime, { recursive: true, force: true })
      fs.rmSync(root, { recursive: true, force: true })
    }
  })

  it("normalizes legacy plans and validates durable merge metadata", async () => {
    const root = workspace()
    const protocol = new PlanProtocol()
    await protocol.create(context(root), createInput())
    const read = await protocol.read(context(root))
    if (!read.ok || !read.plan) return

    const legacy = structuredClone(read.plan) as PlanFile
    delete legacy.steps[0]!.tasks[0]!.mode
    delete legacy.steps[0]!.tasks[0]!.merge
    legacy.steps[0]!.tasks[0]!.timeout_ms = 900_000
    const normalized = normalizePlanFile(legacy) as PlanFile
    expect(normalized.steps[0]?.tasks[0]?.mode).toBe("standard")
    expect(normalized.steps[0]?.tasks[0]?.merge).toBeUndefined()
    expect(normalized.steps[0]?.tasks[0]?.timeout_ms).toBeUndefined()
    expect(fs.readFileSync(planFilePath(root, "ses_main"), "utf8")).not.toContain('"merge"')

    const task = normalized.steps[0]!.tasks[0]!
    task.status = "approved"
    task.dispatch = {
      run_id: "run__ses_main__s1_t1",
      child_session_id: "child_s1_t1",
      dispatched_at: new Date().toISOString(),
      cancelled_at: null,
      workspace: {
        mode: "snapshot",
        root,
        directory: path.join(root, ".runtime", "child"),
        created_at: new Date().toISOString(),
        cleanup: "on_success",
        baseline_directory: path.join(root, ".runtime", "baseline"),
        baseline_manifest_hash: "a".repeat(64),
        source_revision: null,
      },
    }
    task.merge = {
      status: "pending",
      attempt: 1,
      applied_paths: [],
      conflicts: [],
      started_at: null,
      completed_at: null,
      target_fingerprint: null,
      cleanup: "not_started",
    }
    expect(validatePlanFile(normalized)).toEqual([])
    expect(isStepComplete(normalized.steps[0]!, root)).toBe(false)
    task.merge.status = "merged"
    expect(isStepComplete(normalized.steps[0]!, root)).toBe(true)

    task.merge.status = "unknown" as never
    expect(validatePlanFile(normalized)).toContain("plan.steps[0].tasks[0].merge: invalid merge record")
  })

  it("keeps report retry state and Inbox entries across protocol calls", async () => {
    const root = workspace()
    const missingArtifact = path.join(root, "not-created.md")
    const rootContext = context(root)
    const sharedInbox = new PlanInbox()
    const creator = new PlanProtocol({ children: createHardeningChildren().controller, inbox: sharedInbox })
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

    const read = await new PlanProtocol({ inbox: sharedInbox }).read(rootContext)
    if (!read.ok || !read.progress) return
    expect(read.progress.inbox_pending).toBe(1)
    const inbox = await new PlanProtocol({ inbox: sharedInbox }).readInbox(rootContext)
    expect(inbox.ok).toBe(true)
    if (!inbox.ok) return
    expect(inbox.items[0]?.kind).toBe("report_precheck_failed")
    const handled = await new PlanProtocol({ inbox: sharedInbox }).readInbox(rootContext, {
      mark_handled: [inbox.items[0]!.id],
    })
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

  it("does not create a child when the reservation write fails", async () => {
    const fixture = createHardeningWorkspace()
    try {
      const store = new FailingPlanStore()
      const children = createHardeningChildren()
      const protocol = new PlanProtocol({ store, children: children.controller })
      const root = hardeningContext(fixture.root)
      await protocol.create(root, hardeningPlanInput(path.join(fixture.root, "output")))
      store.failWrites = true
      const dispatched = await protocol.dispatch(root, { taskIds: ["s1_t1"], role: "general" })
      expect(dispatched).toMatchObject({ ok: false })
      expect(children.calls.create).toBe(0)
      expect(readHardeningPlan(fixture.root).steps[0]?.tasks[0]?.status).toBe("pending")
    } finally {
      fixture.cleanup()
    }
  })

  it("dispatches isolated children with child-relative brief paths and parent plan writes", async () => {
    const fixture = createHardeningWorkspace()
    const runtime = fs.mkdtempSync(path.join(os.tmpdir(), "jyycode-child-runtime-"))
    try {
      let createdInput: ChildStartInput | undefined
      const protocol = new PlanProtocol({
        childWorkspace: new ChildWorkspace({
          project: { root: fixture.root, vcs: "none" },
          runtimeRoot: runtime,
        }),
        children: {
          async create(input) {
            createdInput = input
            return input.childSessionId
          },
          async start() {},
          async terminate() {},
        },
      })
      const root = hardeningContext(fixture.root)
      const plan = hardeningPlanInput("out/result.md")
      const task = plan.steps[0]?.tasks?.[0]
      if (!task) throw new Error("hardening fixture is missing its task")
      task.instructions = `Create ${fixture.root.replaceAll("\\", "/")}/out/result.md with the requested result.`
      task.goal = `Produce a result under ${fixture.root}/out.`
      task.done_criteria = `${fixture.root}/out/result.md exists.`
      await protocol.create(root, plan)
      const dispatched = await protocol.dispatch(root, { taskIds: ["s1_t1"], role: "general" })
      expect(dispatched.ok).toBe(true)
      if (!dispatched.ok || !createdInput) return
      const workspaceDirectory = createdInput.workspace?.directory
      expect(createdInput.workspace?.mode).toBe("snapshot")
      expect(workspaceDirectory).toBeTruthy()
      if (!workspaceDirectory) return
      expect(createdInput.planRoot).toBe(fixture.root)
      expect(createdInput.brief.workspace_root).toBe(workspaceDirectory)
      expect(createdInput.brief.output_path).toBe(path.join(workspaceDirectory, "out", "result.md"))
      expect(JSON.stringify(createdInput.brief)).not.toContain(fixture.root)
      expect(createdInput.brief.task_instructions).toContain(workspaceDirectory)
      expect(createdInput.brief.task_instructions).toContain("out/result.md")

      fs.mkdirSync(path.dirname(createdInput.brief.output_path), { recursive: true })
      fs.writeFileSync(createdInput.brief.output_path, "child result")
      const runId = dispatched.dispatched[0]!.run_id
      const reported = await protocol.report(
        { workspaceRoot: workspaceDirectory, sessionId: "child_s1_t1", mode: "single", runId },
        { run_id: runId, status: "done", summary: "ready", artifacts: [createdInput.brief.output_path], issues: [] },
      )
      expect(reported.ok).toBe(true)
      expect(readHardeningPlan(fixture.root).steps[0]?.tasks[0]?.status).toBe("reported")
    } finally {
      fs.rmSync(runtime, { recursive: true, force: true })
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
    const revisionBeforeReport = unchanged.plan.revision
    expect(revisionBeforeReport).toBeGreaterThan(2)
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
    const beforeReview = await protocol.read(context(root))
    if (!beforeReview.ok || !beforeReview.plan) return
    const reviewRevision = beforeReview.plan.revision
    const blocked = await protocol.update(context(root), {
      revision: reviewRevision,
      ops: [{ op: "review_task", stepId: "s1", taskId: "s1_t1", decision: "approve" }],
    })
    expect(blocked).toMatchObject({ ok: false, error: { code: "BLACKBOARD_UNREAD", retryable: true } })
    const unchanged = await protocol.read(context(root))
    expect(unchanged).toMatchObject({ ok: true, plan: { revision: reviewRevision, current_step: "s1" } })

    blackboardClear = true
    const advanced = await protocol.update(context(root), {
      revision: reviewRevision,
      ops: [{ op: "review_task", stepId: "s1", taskId: "s1_t1", decision: "approve" }],
    })
    expect(advanced.ok).toBe(true)
    const after = await protocol.read(context(root))
    expect(after).toMatchObject({ ok: true, plan: { revision: reviewRevision + 1, current_step: "s2" } })
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
    expect(planSystemPrompt({ child: true, multiAgent: true })).toContain("artifact")
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
    expect(multiAgentPrompt).toContain("Root multi-agent protocol")
    expect(multiAgentPrompt).toContain("Dispatch every ready task")
    expect(multiAgentPrompt).toContain("Create the plan exactly once")
    expect(multiAgentPrompt).toContain("Later steps should be skeletons")
    expect(multiAgentPrompt).toContain("never retry Plan_create in the same turn")
    expect(multiAgentPrompt).toContain("call Dispatch_dispatch directly to continue the existing child session")
    expect(multiAgentPrompt).toContain("Do not call reopen_task for this revision path")
    expect(multiAgentPrompt).toContain("only paths relative to that child's future workspace_root")
    expect(multiAgentPrompt).toContain("Never include an absolute path")
    expect(multiAgentPrompt).toContain("never poll children")
    expect(multiAgentPrompt).toContain("Merge only approved work")
    expect(multiAgentPrompt).toContain("Blackboard only for decisions")
    expect(multiAgentPrompt).not.toMatch(/\b(?:Plan|Dispatch|Candidate)\./)
    expect(multiAgentPrompt).not.toContain("Blackboard.reply")
    expect(multiAgentPrompt).not.toContain("Merge.apply")
    expect(multiAgentPrompt).toContain("output_path")
    expect(multiAgentPrompt).toContain("reviewer")
    expect(planSystemPrompt({ child: false, multiAgent: true, profiles: [] })).toContain("No enabled sub-agent roles")
    expect(planSystemPrompt({ child: false, multiAgent: false })).toContain("Root single-agent protocol")
    const childPrompt = planSystemPrompt({ child: true, multiAgent: true })
    expect(childPrompt).toContain("workspace_root")
    expect(childPrompt).toContain("honest done, partial, or failed outcome")
    expect(childPrompt).not.toContain("Blackboard.reply")
    expect(childPrompt).toContain("Write the requested artifact first")
    expect(childPrompt).not.toContain("Plan_create")
    expect(childPrompt).not.toContain("Dispatch_dispatch")
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
    expect(retried.dispatched[0]?.run_id).not.toBe(runId)
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

    expect(await protocol.cancel(context(root), ["s1_t1"])).toMatchObject({
      ok: false,
      error: { code: "INVALID_STATE" },
    })
    expect(await settle()).toEqual({ settled: false, reason: "already_settled" })
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
