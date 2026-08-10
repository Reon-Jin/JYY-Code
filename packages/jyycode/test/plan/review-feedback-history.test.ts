import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { describe, expect, it } from "bun:test"
import { PlanProtocol, type ChildStartInput } from "../../src/plan/protocol"
import { PlanStore } from "../../src/plan/store"

function workspace() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "jyycode-review-history-"))
}

function context(workspaceRoot: string, sessionId = "ses_main") {
  return { workspaceRoot, sessionId, mode: "multi" as const }
}

describe("review feedback history", () => {
  it("persists every rejection so later retries receive every round", async () => {
    const root = workspace()
    const artifact = path.join(root, "notes.md")
    fs.writeFileSync(artifact, "notes")
    const starts: ChildStartInput[] = []
    const protocol = new PlanProtocol({
      store: new PlanStore(),
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

    try {
      await protocol.create(context(root), {
        title: "Documentation",
        goal: "Document the API",
        steps: [
          {
            title: "Write notes",
            goal: "Write the notes",
            done_criteria: "notes.md exists",
            tasks: [
              {
                title: "Write notes",
                goal: "Write the notes",
                done_criteria: "notes.md exists",
                output_path: artifact,
              },
            ],
          },
          { title: "Finish", goal: "Finish", done_criteria: "done" },
        ],
      })

      const first = await protocol.dispatch(context(root), { taskIds: ["s1_t1"], role: "general" })
      expect(first).toMatchObject({ ok: true })
      if (!first.ok) return

      const firstRun = first.dispatched[0]
      if (!firstRun) return
      await protocol.report(
        { ...context(root, firstRun.child_session_id), mode: "single", runId: firstRun.run_id },
        { run_id: firstRun.run_id, status: "done", summary: "first", artifacts: [artifact], issues: [] },
      )
      const firstReview = await protocol.read(context(root))
      if (!firstReview.ok || !firstReview.plan) return
      const rejectedOnce = await protocol.update(context(root), {
        revision: firstReview.plan.revision,
        ops: [{ op: "review_task", stepId: "s1", taskId: "s1_t1", decision: "reject", feedback: "Add examples" }],
      })
      expect(rejectedOnce).toMatchObject({ ok: true, dispatched: [{ taskId: "s1_t1" }] })
      expect(starts[1]?.brief.review_feedback_history).toEqual([
        { review_feedback: "Add examples", issues: [] },
      ])

      if (!rejectedOnce.ok) return
      const secondRun = rejectedOnce.dispatched?.[0]
      if (!secondRun) return
      await protocol.report(
        { ...context(root, secondRun.child_session_id), mode: "single", runId: secondRun.run_id },
        { run_id: secondRun.run_id, status: "done", summary: "second", artifacts: [artifact], issues: [] },
      )
      const secondReview = await protocol.read(context(root))
      if (!secondReview.ok || !secondReview.plan) return
      const rejectedTwice = await protocol.update(context(root), {
        revision: secondReview.plan.revision,
        ops: [
          { op: "review_task", stepId: "s1", taskId: "s1_t1", decision: "reject", feedback: "Cover pagination" },
        ],
      })
      expect(rejectedTwice).toMatchObject({ ok: true, dispatched: [{ taskId: "s1_t1" }] })
      expect(starts[2]?.brief.review_feedback_history).toEqual([
        { review_feedback: "Add examples", issues: [] },
        { review_feedback: "Cover pagination", issues: [] },
      ])
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })

  it("continues repeated review retries in the same child session", async () => {
    const root = workspace()
    const artifact = path.join(root, "notes.md")
    fs.writeFileSync(artifact, "notes")
    const created: ChildStartInput[] = []
    const resumed: ChildStartInput[] = []
    const terminated: string[] = []
    const protocol = new PlanProtocol({
      store: new PlanStore(),
      children: {
        async create(input) {
          created.push(input)
          return input.childSessionId
        },
        async start() {},
        async resume(input) {
          resumed.push(input)
        },
        async terminate(sessionID) {
          terminated.push(sessionID)
        },
      },
    })

    try {
      await protocol.create(context(root), {
        title: "Documentation",
        goal: "Document the API",
        steps: [
          {
            title: "Write notes",
            goal: "Write the notes",
            done_criteria: "notes.md exists",
            tasks: [
              {
                title: "Write notes",
                goal: "Write the notes",
                done_criteria: "notes.md exists",
                output_path: artifact,
              },
            ],
          },
          { title: "Finish", goal: "Finish", done_criteria: "done" },
        ],
      })

      const first = await protocol.dispatch(context(root), { taskIds: ["s1_t1"], role: "general" })
      expect(first).toMatchObject({ ok: true })
      if (!first.ok) return
      const firstRun = first.dispatched[0]!
      await protocol.report(
        { ...context(root, firstRun.child_session_id), mode: "single", runId: firstRun.run_id },
        { run_id: firstRun.run_id, status: "done", summary: "first", artifacts: [artifact], issues: [] },
      )

      const firstReview = await protocol.read(context(root))
      if (!firstReview.ok || !firstReview.plan) return
      const firstRejected = await protocol.update(context(root), {
        revision: firstReview.plan.revision,
        ops: [{ op: "review_task", stepId: "s1", taskId: "s1_t1", decision: "reject", feedback: "Add examples" }],
      })
      expect(firstRejected).toMatchObject({ ok: true, dispatched: [{ taskId: "s1_t1" }] })
      if (!firstRejected.ok) return
      const secondRun = firstRejected.dispatched?.[0]
      if (!secondRun) return

      expect(created).toHaveLength(1)
      expect(resumed).toHaveLength(1)
      expect(resumed[0]?.childSessionId).toBe(firstRun.child_session_id)
      expect(resumed[0]?.brief.run_id).toBe(secondRun.run_id)
      expect(resumed[0]?.brief.previous_feedback?.review_feedback).toBe("Add examples")
      expect(resumed[0]?.brief.review_feedback_history).toEqual([
        { review_feedback: "Add examples", issues: [] },
      ])
      expect(terminated).toHaveLength(0)

      await protocol.report(
        { ...context(root, secondRun.child_session_id), mode: "single", runId: secondRun.run_id },
        { run_id: secondRun.run_id, status: "done", summary: "second", artifacts: [artifact], issues: [] },
      )
      const secondReview = await protocol.read(context(root))
      if (!secondReview.ok || !secondReview.plan) return
      const secondRejected = await protocol.update(context(root), {
        revision: secondReview.plan.revision,
        ops: [{ op: "review_task", stepId: "s1", taskId: "s1_t1", decision: "reject", feedback: "Cover pagination" }],
      })
      expect(secondRejected).toMatchObject({ ok: true, dispatched: [{ taskId: "s1_t1" }] })
      if (!secondRejected.ok) return
      const thirdRun = secondRejected.dispatched?.[0]
      if (!thirdRun) return

      expect(created).toHaveLength(1)
      expect(resumed).toHaveLength(2)
      expect(resumed[1]?.childSessionId).toBe(firstRun.child_session_id)
      expect(resumed[1]?.brief.run_id).toBe(thirdRun.run_id)
      expect(resumed[1]?.brief.previous_feedback?.review_feedback).toBe("Cover pagination")
      expect(resumed[1]?.brief.review_feedback_history).toEqual([
        { review_feedback: "Add examples", issues: [] },
        { review_feedback: "Cover pagination", issues: [] },
      ])
      expect(thirdRun.run_id).not.toBe(secondRun.run_id)
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })
})
