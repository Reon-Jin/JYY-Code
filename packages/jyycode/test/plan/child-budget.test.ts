import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { describe, expect, it } from "bun:test"
import { defaultGeneralProfile } from "../../src/agent/subagent-profile"
import { PlanProtocol, resolveChildBudget } from "../../src/plan/protocol"
import { PlanStore } from "../../src/plan/store"

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
  it("uses finite defaults and propagates the smallest parent deadline", () => {
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

    expect(budget.max_steps).toBe(7)
    expect(Date.parse(budget.deadline_at)).toBe(now + 5_000)
    expect(budget.no_progress_steps).toBe(3)
    expect(budget.source).toBe("parent")

    const defaults = resolveChildBudget({ now })
    expect(Number.isFinite(defaults.max_steps)).toBe(true)
    expect(Number.isFinite(Date.parse(defaults.deadline_at))).toBe(true)
    expect(defaults.max_steps).toBe(60)
    expect(defaults.no_progress_steps).toBe(8)
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

    await protocol.create(
      { workspaceRoot: root, sessionId: "ses_main", mode: "multi" },
      planInput(),
    )
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
    expect(firstDispatch.max_steps).toBe(60)
    expect(firstDispatch.no_progress_steps).toBe(8)
    expect(firstDispatch.source).toBe("default")
    expect(firstDispatch.budget).toMatchObject({ max_steps: 60, no_progress_steps: 8, source: "default" })

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
    expect(retryDispatch.max_steps).toBe(3)
    expect(retryDispatch.no_progress_steps).toBe(2)
    expect(retryDispatch.source).toBe("profile")
    expect(retryDispatch.deadline_at).not.toBe(firstDispatch.deadline_at)
  })
})
