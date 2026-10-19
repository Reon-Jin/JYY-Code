import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { describe, expect, it } from "bun:test"
import { defaultGeneralProfile } from "../../src/agent/subagent-profile"
import { DEFAULT_AGENT_DEADLINE_MS } from "../../src/config/agent"
import { PlanProtocol, resolveChildBudget } from "../../src/plan/protocol"
import { PlanStore } from "../../src/plan/store"
import { tmpdir } from "../fixture/fixture"

function workspace() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "jyycode-child-budget-"))
}

function planInput() {
  return {
    title: "bounded child",
    goal: "verify child execution limits",
    steps: [
      {
        title: "execute",
        goal: "run the child",
        done_criteria: "the child reports",
        tasks: [
          {
            title: "bounded task",
            goal: "produce the result",
            done_criteria: "the output exists",
            output_path: "out/result.md",
          },
        ],
      },
      { title: "review", goal: "review the result", done_criteria: "accepted" },
    ],
  }
}

describe("child execution budgets", () => {
  it("applies user settings to new dispatches and retries without rewriting a running budget", async () => {
    await using dir = await tmpdir()
    const now = Date.parse("2026-10-19T00:00:00Z")
    const ctx = { workspaceRoot: dir.path, sessionId: "ses_user_timeout", mode: "multi" as const }
    const makeProtocol = (timeoutMs: number) =>
      new PlanProtocol({
        store: new PlanStore(),
        now: () => now,
        childTimeoutMs: timeoutMs,
        children: {
          async create(input) {
            return input.childSessionId
          },
          async start() {},
          async resume() {},
          async terminate() {},
        },
      })
    const old = makeProtocol(20 * 60_000)
    const input = planInput()
    input.steps[0]!.tasks!.push({
      title: "Second",
      goal: "Second",
      done_criteria: "second.md exists",
      output_path: "second.md",
    })
    expect(await old.create(ctx, input)).toMatchObject({ ok: true })
    expect(await old.dispatch(ctx, { taskIds: ["s1_t1"], role: "general" })).toMatchObject({ ok: true })
    const updated = makeProtocol(45 * 60_000)
    expect(await updated.dispatch(ctx, { taskIds: ["s1_t2"], role: "general" })).toMatchObject({ ok: true })
    const read = await updated.read(ctx)
    if (!read.ok || !read.plan) throw new Error("missing plan")
    expect(read.plan.steps[0]!.tasks.map((task) => task.dispatch!.deadline_at)).toEqual([
      new Date(now + 20 * 60_000).toISOString(),
      new Date(now + 45 * 60_000).toISOString(),
    ])
    expect(await updated.cancel(ctx, ["s1_t1"])).toMatchObject({ ok: true })
    expect(await updated.dispatch(ctx, { taskIds: ["s1_t1"], role: "general" })).toMatchObject({ ok: true })
    const retry = await updated.read(ctx)
    if (!retry.ok || !retry.plan) throw new Error("missing plan")
    expect(retry.plan.steps[0]!.tasks[0]!.dispatch!.deadline_at).toBe(new Date(now + 45 * 60_000).toISOString())
    const second = retry.plan.steps[0]!.tasks[1]!.dispatch!
    fs.writeFileSync(path.join(dir.path, "second.md"), "Ready for review")
    expect(
      await updated.report(
        { workspaceRoot: dir.path, sessionId: second.child_session_id, mode: "single", runId: second.run_id },
        {
          run_id: second.run_id,
          status: "done",
          summary: "Ready",
          artifacts: [path.join(dir.path, "second.md")],
          issues: [],
        },
      ),
    ).toMatchObject({ ok: true })
    const reviewing = makeProtocol(10 * 60_000)
    const reported = await reviewing.read(ctx)
    if (!reported.ok || !reported.plan) throw new Error("missing plan")
    expect(
      await reviewing.update(ctx, {
        revision: reported.plan.revision,
        ops: [
          {
            op: "review_task",
            stepId: "s1",
            taskId: "s1_t2",
            decision: "reject",
            feedback: "Revise the result",
          },
        ],
      }),
    ).toMatchObject({ ok: true, dispatched: [{ taskId: "s1_t2", idempotent: false }] })
    const automaticRetry = await reviewing.read(ctx)
    if (!automaticRetry.ok || !automaticRetry.plan) throw new Error("missing plan")
    expect(automaticRetry.plan.steps[0]!.tasks[1]!.dispatch!.deadline_at).toBe(
      new Date(now + 10 * 60_000).toISOString(),
    )
  })

  it("uses a fixed maximum step budget and propagates the smallest parent deadline", () => {
    const now = Date.parse("2026-08-09T00:00:00.000Z")
    const budget = resolveChildBudget({
      now,
      parent: {
        max_steps: 7,
        deadline_at: new Date(now + 5_000).toISOString(),
        no_progress_steps: 3,
        source: "parent",
      },
    })

    expect(budget.max_steps).toBe(1024)
    expect(Date.parse(budget.deadline_at)).toBe(now + 5_000)
    expect(budget.no_progress_steps).toBe(3)
    expect(budget.source).toBe("parent")

    const defaults = resolveChildBudget({ now })
    expect(Date.parse(defaults.deadline_at)).toBe(now + 60 * 60 * 1000)
    expect(Number.isFinite(defaults.max_steps)).toBe(true)
    expect(Number.isFinite(Date.parse(defaults.deadline_at))).toBe(true)
    expect(defaults.max_steps).toBe(1024)
    expect(defaults.no_progress_steps).toBe(8)
    const configured = resolveChildBudget({ now, timeoutMs: 20 * 60_000 })
    expect(Date.parse(configured.deadline_at)).toBe(now + 20 * 60_000)
    expect(configured.source).toBe("config")
    expect(Date.parse(resolveChildBudget({ now, timeoutMs: 120 * 60_000 }).deadline_at)).toBe(now + 60 * 60_000)
    expect(
      Date.parse(
        resolveChildBudget({
          now,
          timeoutMs: 20 * 60_000,
          parent: { deadline_at: new Date(now + 5_000).toISOString() },
        }).deadline_at,
      ),
    ).toBe(now + 5_000)

    const modelOverrides = resolveChildBudget({
      now,
      role: { no_progress_steps: 2 },
      task: { no_progress_steps: 2 },
    })
    expect(Date.parse(modelOverrides.deadline_at)).toBe(now + DEFAULT_AGENT_DEADLINE_MS)
    expect(modelOverrides.max_steps).toBe(1024)
    expect(modelOverrides.source).toBe("profile")
  })

  it("persists an immutable dispatch snapshot and creates a fresh retry run", async () => {
    const root = workspace()
    let now = Date.parse("2026-08-09T00:00:00.000Z")
    let profiles = [defaultGeneralProfile]
    const protocol = new PlanProtocol({
      store: new PlanStore(),
      now: () => now,
      profiles: async () => profiles,
      children: {
        async create(input) {
          return input.childSessionId
        },
        async start() {},
        async terminate() {},
      },
    })

    await protocol.create({ workspaceRoot: root, sessionId: "ses_main", mode: "multi" }, planInput())
    const first = await protocol.dispatch(
      { workspaceRoot: root, sessionId: "ses_main", mode: "multi" },
      { taskIds: ["s1_t1"], role: "general" },
    )
    expect(first.ok).toBe(true)
    if (!first.ok) return

    const firstRun = first.dispatched[0]!.run_id
    const stored = await protocol.read({ workspaceRoot: root, sessionId: "ses_main", mode: "multi" })
    if (!stored.ok || !stored.plan) return
    const firstDispatch = stored.plan.steps[0]!.tasks[0]!.dispatch!
    expect(firstDispatch.max_steps).toBe(1024)
    expect(firstDispatch.no_progress_steps).toBe(8)
    expect(firstDispatch.source).toBe("default")
    expect(firstDispatch.budget).toMatchObject({ max_steps: 1024, no_progress_steps: 8, source: "default" })

    await protocol.cancel({ workspaceRoot: root, sessionId: "ses_main", mode: "multi" }, ["s1_t1"])
    profiles = [
      {
        ...defaultGeneralProfile,
        steps: 3,
        timeout_ms: 2_000,
        no_progress_steps: 2,
      },
    ]
    now += 1_000
    const retry = await protocol.dispatch(
      { workspaceRoot: root, sessionId: "ses_main", mode: "multi" },
      { taskIds: ["s1_t1"], role: "general" },
    )
    expect(retry.ok).toBe(true)
    if (!retry.ok) return
    expect(retry.dispatched[0]!.run_id).not.toBe(firstRun)

    const retried = await protocol.read({ workspaceRoot: root, sessionId: "ses_main", mode: "multi" })
    if (!retried.ok || !retried.plan) return
    const retryDispatch = retried.plan.steps[0]!.tasks[0]!.dispatch!
    expect(retryDispatch.max_steps).toBe(1024)
    expect(retryDispatch.no_progress_steps).toBe(2)
    expect(retryDispatch.source).toBe("profile")
    expect(Date.parse(retryDispatch.deadline_at ?? "")).toBe(now + DEFAULT_AGENT_DEADLINE_MS)
    expect(retryDispatch.deadline_at).not.toBe(firstDispatch.deadline_at)
  })
})
