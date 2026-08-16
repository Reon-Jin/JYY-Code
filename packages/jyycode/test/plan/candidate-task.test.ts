import { describe, expect, it } from "bun:test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { isStepComplete, readPlanFileSync, validatePlanFile, type PlanStep } from "../../src/plan/schema"
import { PlanProtocol } from "../../src/plan/protocol"
import { PlanStore } from "../../src/plan/store"
import { projectPlanSnapshot } from "../../src/plan/snapshot"

function workspace() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "jyycode-candidate-"))
}

function task(id: string, status: PlanStep["tasks"][number]["status"] = "pending") {
  return {
    id,
    title: id,
    goal: "test",
    done_criteria: "test",
    output_path: null,
    status,
    dispatch: null,
    report: null,
  }
}

function candidateTask(id: string, status: PlanStep["tasks"][number]["status"] = "pending") {
  return {
    ...task(id, status),
    mode: "candidate" as const,
    output_path: path.join(".jyycode", "plan", "candidate", id, "proposal.md"),
  }
}

describe("candidate plan model", () => {
  it("runs one candidate dispatch through declare, ready, begin, submit, and select", async () => {
    const root = workspace()
    const taskIDs = ["s1_t1", "s1_t2", "s1_t3"]
    const declarations: Array<{ id: string; authorTaskID?: string }> = []
    const peerReplies = new Map(taskIDs.map((taskID) => [taskID, new Set<string>()]))
    const protocol = new PlanProtocol({
      store: new PlanStore(),
      children: {
        async create(input) {
          return input.childSessionId
        },
        async start() {},
        async terminate() {},
      },
      candidateBoard: {
        async postCandidateDeclaration(input) {
          const taskID = input.sessionID.endsWith("t1") ? "s1_t1" : input.sessionID.endsWith("t2") ? "s1_t2" : "s1_t3"
          declarations.push({ id: `decl-${taskID}`, authorTaskID: taskID })
          return {}
        },
        async candidateDeclarations() {
          return declarations
        },
        async candidatePeerReplyCoverage(input) {
          const replied = peerReplies.get(input.taskID) ?? new Set<string>()
          const missingTaskIDs = taskIDs.filter((taskID) => taskID !== input.taskID && !replied.has(taskID))
          return { missingTaskIDs, complete: missingTaskIDs.length === 0 }
        },
        async candidateParticipants() {
          return taskIDs.map((taskID) => ({ taskID, sessionID: `child_ses_main_${taskID}` }))
        },
      },
    })
    const context = (sessionId = "ses_main", runId?: string, workspaceRoot = root) => ({
      workspaceRoot,
      planRoot: root,
      sessionId,
      mode: "multi" as const,
      ...(runId ? { runId } : {}),
    })
    const created = await protocol.create(context(), {
      title: "compare",
      goal: "compare approaches",
      steps: [
        {
          title: "candidate",
          goal: "compare",
          done_criteria: "select one",
          tasks: taskIDs.map((id, index) => ({
            title: `design-${index + 1}`,
            goal: "design",
            done_criteria: "proposal",
            mode: "candidate",
          })),
        },
        { title: "next", goal: "continue", done_criteria: "done" },
      ],
    })
    expect(created).toMatchObject({ ok: true, next_action_hint: expect.stringContaining("一次调用 Dispatch_dispatch") })
    let read = await protocol.read(context())
    if (!read.ok || !read.plan) throw new Error("candidate plan was not created")
    expect(read.plan.steps[0]?.tasks.map((item) => item.mode)).toEqual(["candidate", "candidate", "candidate"])
    expect(path.normalize(read.plan.steps[0]?.tasks[0]?.output_path ?? "")).toContain(
      path.normalize(path.join("candidates", "s1", "s1_t1", "proposal.md")),
    )
    expect(
      await protocol.update(context(), {
        revision: read.plan.revision,
        ops: [
          {
            op: "add_task",
            stepId: "s1",
            task: { title: "late", goal: "late", done_criteria: "late", mode: "candidate" },
          },
        ],
      }),
    ).toMatchObject({ ok: false, error: { hint: expect.stringContaining("Plan_create") } })
    expect(await protocol.dispatch(context(), { taskIds: ["s1_t1", "s1_t2"], role: "general" })).toMatchObject({
      ok: false,
    })
    const dispatched = await protocol.dispatch(context(), { taskIds: taskIDs, role: "general" })
    expect(dispatched).toMatchObject({ ok: true })
    if (!dispatched.ok) throw new Error("candidate dispatch failed")
    const runs = new Map(dispatched.dispatched.map((item) => [item.taskId, item]))

    for (const taskID of taskIDs) {
      const childID = runs.get(taskID)!.child_session_id
      const runID = runs.get(taskID)!.run_id
      expect(
        await protocol.candidateDeclare(context(childID, runID), {
          approach: taskID,
          assumptions: ["a"],
          risks: ["r"],
          differentiator: taskID,
        }),
      ).toMatchObject({ ok: true })
    }
    for (const taskID of taskIDs) {
      for (const peerTaskID of taskIDs) if (peerTaskID !== taskID) peerReplies.get(taskID)!.add(peerTaskID)
    }
    for (const taskID of taskIDs) {
      const childID = runs.get(taskID)!.child_session_id
      const runID = runs.get(taskID)!.run_id
      expect(await protocol.candidateReady(context(childID, runID))).toMatchObject({ ok: true })
    }
    expect(await protocol.candidateBegin(context())).toMatchObject({ ok: true, phase: "running" })
    for (const taskID of taskIDs) {
      const childID = runs.get(taskID)!.child_session_id
      const runID = runs.get(taskID)!.run_id
      expect(
        await protocol.candidateSubmit(context(childID, runID, path.join(root, "isolated-child")), {
          run_id: runID,
          status: "done",
          summary: `proposal ${taskID}`,
          proposal: `# ${taskID}`,
        }),
      ).toMatchObject({ ok: true })
    }
    const synthesis = path.join(root, "synthesis.md")
    fs.writeFileSync(synthesis, "combined")
    read = await protocol.read(context())
    if (!read.ok || !read.plan) throw new Error("candidate plan disappeared")
    const selected = await protocol.update(context(), {
      revision: read.plan.revision,
      ops: [
        {
          op: "select_candidate",
          stepId: "s1",
          selectedTaskId: "s1_t2",
          contributingTaskIds: ["s1_t1"],
          synthesisArtifact: synthesis,
          rationale: "best",
        },
      ],
    })
    expect(selected).toMatchObject({ ok: true })
    read = await protocol.read(context())
    if (!read.ok || !read.plan) throw new Error("candidate plan disappeared")
    expect(read.plan.steps[0]?.tasks.map((item) => item.status)).toEqual(["dismissed", "approved", "dismissed"])
    expect(read.plan.current_step).toBe("s2")
  })

  it("rejects invalid candidate transitions without changing the plan revision", async () => {
    const root = workspace()
    const taskIDs = ["s1_t1", "s1_t2"]
    const declarations: Array<{ id: string; authorTaskID?: string }> = []
    let coverage = false
    const protocol = new PlanProtocol({
      store: new PlanStore(),
      children: {
        async create(input) {
          return input.childSessionId
        },
        async start() {},
        async terminate() {},
      },
      candidateBoard: {
        async postCandidateDeclaration(input) {
          const taskID = input.sessionID.endsWith("t1") ? "s1_t1" : "s1_t2"
          declarations.push({ id: `decl-${taskID}`, authorTaskID: taskID })
          return {}
        },
        async candidateDeclarations() {
          return declarations
        },
        async candidatePeerReplyCoverage() {
          return { missingTaskIDs: coverage ? [] : ["s1_t2"], complete: coverage }
        },
        async candidateParticipants() {
          return taskIDs.map((taskID) => ({ taskID, sessionID: `child_ses_invalid_${taskID}` }))
        },
      },
    })
    const context = (sessionId = "ses_invalid", runId?: string) => ({
      workspaceRoot: root,
      sessionId,
      mode: "multi" as const,
      ...(runId ? { runId } : {}),
    })
    expect(
      await protocol.create(context(), {
        title: "mixed",
        goal: "reject mixed groups",
        steps: [
          {
            title: "mixed",
            goal: "mixed",
            done_criteria: "reject",
            tasks: [
              { title: "candidate", goal: "candidate", done_criteria: "x", mode: "candidate" },
              { title: "standard", goal: "standard", done_criteria: "x" },
            ],
          },
          { title: "next", goal: "next", done_criteria: "next" },
        ],
      }),
    ).toMatchObject({ ok: false })

    const created = await protocol.create(context(), {
      title: "invalid transitions",
      goal: "reject invalid transitions",
      steps: [
        {
          title: "candidate",
          goal: "candidate",
          done_criteria: "select",
          tasks: taskIDs.map((id) => ({ title: id, goal: id, done_criteria: "proposal", mode: "candidate" as const })),
        },
        { title: "next", goal: "next", done_criteria: "done" },
      ],
    })
    expect(created).toMatchObject({ ok: true })
    const dispatched = await protocol.dispatch(context(), { taskIds: taskIDs, role: "general" })
    expect(dispatched).toMatchObject({ ok: true })
    if (!dispatched.ok) throw new Error("invalid-transition dispatch failed")
    const runs = new Map(dispatched.dispatched.map((item) => [item.taskId, item]))
    const firstRun = runs.get("s1_t1")!
    const child = context(firstRun.child_session_id, firstRun.run_id)
    const before = await protocol.read(context())
    if (!before.ok || !before.plan) throw new Error("invalid-transition plan was not created")
    expect(await protocol.candidateReady(child)).toMatchObject({ ok: false })
    expect(
      await protocol.candidateSubmit(child, {
        run_id: child.runId,
        status: "done",
        summary: "too early",
        proposal: "# no",
      }),
    ).toMatchObject({ ok: false })
    expect(
      await protocol.report(child, { run_id: child.runId, status: "done", summary: "wrong protocol", artifacts: [] }),
    ).toMatchObject({ ok: false })
    expect(
      await protocol.update(child, {
        revision: before.plan.revision,
        ops: [
          {
            op: "select_candidate",
            stepId: "s1",
            selectedTaskId: "s1_t1",
            synthesisArtifact: "synthesis.md",
            rationale: "no",
          },
        ],
      }),
    ).toMatchObject({ ok: false })
    expect((await protocol.read(context())).ok && ((await protocol.read(context())) as any).plan.revision).toBe(
      before.plan.revision,
    )

    for (const taskID of taskIDs) {
      const childID = runs.get(taskID)!.child_session_id
      const runID = runs.get(taskID)!.run_id
      expect(
        await protocol.candidateDeclare(context(childID, runID), {
          approach: taskID,
          assumptions: ["a"],
          risks: ["r"],
          differentiator: taskID,
        }),
      ).toMatchObject({ ok: true })
    }
    expect(await protocol.candidateReady(child)).toMatchObject({ ok: false })
    const afterMissingReply = await protocol.read(context())
    if (!afterMissingReply.ok || !afterMissingReply.plan) throw new Error("missing-reply plan was not created")
    expect(afterMissingReply.plan.revision).toBe(before.plan.revision + 1)
    coverage = true
    expect(await protocol.candidateReady(child)).toMatchObject({ ok: true })
    const secondRun = runs.get("s1_t2")!
    expect(await protocol.candidateReady(context(secondRun.child_session_id, secondRun.run_id))).toMatchObject({ ok: true })
    expect(await protocol.candidateBegin(context())).toMatchObject({ ok: true, phase: "running" })

    const synthesis = path.join(root, "synthesis.md")
    fs.writeFileSync(synthesis, "combined")
    expect(
      await protocol.candidateSubmit(child, {
        run_id: child.runId,
        status: "partial",
        summary: "partial",
        proposal: "# partial",
      }),
    ).toMatchObject({ ok: true })
    expect(
      await protocol.candidateSubmit(context(secondRun.child_session_id, secondRun.run_id), {
        run_id: secondRun.run_id,
        status: "done",
        summary: "done",
        proposal: "# done",
      }),
    ).toMatchObject({ ok: true })
    const beforeFailedSelection = await protocol.read(context())
    if (!beforeFailedSelection.ok || !beforeFailedSelection.plan) throw new Error("selection plan was not created")
    expect(
      await protocol.update(context(), {
        revision: beforeFailedSelection.plan.revision,
        ops: [
          {
            op: "select_candidate",
            stepId: "s1",
            selectedTaskId: "s1_t1",
            synthesisArtifact: synthesis,
            rationale: "invalid partial result",
          },
        ],
      }),
    ).toMatchObject({ ok: false })
    const afterFailedSelection = await protocol.read(context())
    if (!afterFailedSelection.ok || !afterFailedSelection.plan) throw new Error("selection plan disappeared")
    expect(afterFailedSelection.plan.revision).toBe(beforeFailedSelection.plan.revision)
  })

  it("initializes a candidate group on a later active Step in one update", async () => {
    const root = workspace()
    const protocol = new PlanProtocol({ store: new PlanStore() })
    const context = { workspaceRoot: root, sessionId: "ses_later_candidate", mode: "multi" as const }
    const singleContext = { ...context, mode: "single" as const }
    const created = await protocol.create(singleContext, {
      title: "later candidate",
      goal: "compare a later decision",
      steps: [
        {
          title: "prepare",
          goal: "prepare",
          done_criteria: "prepare task approved",
          tasks: [{ title: "prepare", goal: "prepare", done_criteria: "prepare", output_path: "prepare.md" }],
        },
        { title: "choose", goal: "compare", done_criteria: "select one" },
      ],
    })
    expect(created).toMatchObject({ ok: true })

    let read = await protocol.read(singleContext)
    if (!read.ok || !read.plan) throw new Error("later candidate plan was not created")
    const started = await protocol.update(singleContext, {
      revision: read.plan.revision,
      ops: [
        { op: "set_task_status", stepId: "s1", taskId: "s1_t1", to: "running" },
        { op: "set_task_status", stepId: "s1", taskId: "s1_t1", to: "reported" },
        { op: "set_task_status", stepId: "s1", taskId: "s1_t1", to: "approved" },
      ],
    })
    expect(started).toMatchObject({ ok: true })

    read = await protocol.read(singleContext)
    if (!read.ok || !read.plan) throw new Error("later candidate plan disappeared")
    expect(read.plan.current_step).toBe("s2")
    const expanded = await protocol.update(context, {
      revision: read.plan.revision,
      ops: [
        {
          op: "add_task",
          stepId: "s2",
          task: { title: "approach A", goal: "compare A", done_criteria: "proposal A", mode: "candidate" },
        },
        {
          op: "add_task",
          stepId: "s2",
          task: { title: "approach B", goal: "compare B", done_criteria: "proposal B", mode: "candidate" },
        },
      ],
    })
    expect(expanded).toMatchObject({ ok: true })
    read = await protocol.read(context)
    if (!read.ok || !read.plan) throw new Error("later candidate plan disappeared")
    expect(read.plan.steps[1]?.tasks.map((task) => task.mode)).toEqual(["candidate", "candidate"])
    expect(read.plan.steps[1]?.candidate_discussion).toEqual({ phase: "declaring", ready_task_ids: [] })
    expect(read.plan.steps[1]?.tasks[0]?.output_path).toMatch(/[\\/]candidates[\\/]s2[\\/]s2_t1[\\/]proposal\.md$/)
  })

  it("rejects incomplete or mixed candidate groups on later Steps", async () => {
    const root = workspace()
    const protocol = new PlanProtocol({ store: new PlanStore() })
    const context = { workspaceRoot: root, sessionId: "ses_invalid_later_candidate", mode: "multi" as const }
    await protocol.create(
      { ...context, mode: "single" as const },
      {
        title: "later candidate validation",
        goal: "validate candidate creation",
        steps: [
          {
            title: "prepare",
            goal: "prepare",
            done_criteria: "prepare task approved",
            tasks: [{ title: "prepare", goal: "prepare", done_criteria: "prepare", output_path: "prepare.md" }],
          },
          { title: "choose", goal: "compare", done_criteria: "select one" },
        ],
      },
    )
    let read = await protocol.read({ ...context, mode: "single" as const })
    if (!read.ok || !read.plan) throw new Error("validation plan was not created")
    await protocol.update(
      { ...context, mode: "single" as const },
      {
        revision: read.plan.revision,
        ops: [
          { op: "set_task_status", stepId: "s1", taskId: "s1_t1", to: "running" },
          { op: "set_task_status", stepId: "s1", taskId: "s1_t1", to: "reported" },
          { op: "set_task_status", stepId: "s1", taskId: "s1_t1", to: "approved" },
        ],
      },
    )
    read = await protocol.read({ ...context, mode: "single" as const })
    if (!read.ok || !read.plan) throw new Error("validation plan disappeared")

    const baseRevision = read.plan.revision
    expect(
      await protocol.update(context, {
        revision: baseRevision,
        ops: [
          {
            op: "add_task",
            stepId: "s2",
            task: { title: "only", goal: "only", done_criteria: "only", mode: "candidate" },
          },
        ],
      }),
    ).toMatchObject({ ok: false, error: { code: "SCHEMA_VALIDATION" } })
    expect((await protocol.read(context)).ok && ((await protocol.read(context)) as any).plan.revision).toBe(
      baseRevision,
    )

    expect(
      await protocol.update(context, {
        revision: baseRevision,
        ops: [
          { op: "add_task", stepId: "s2", task: { title: "A", goal: "A", done_criteria: "A", mode: "candidate" } },
          { op: "add_task", stepId: "s2", task: { title: "B", goal: "B", done_criteria: "B" } },
        ],
      }),
    ).toMatchObject({ ok: false, error: { code: "SCHEMA_VALIDATION" } })
    expect((await protocol.read(context)).ok && ((await protocol.read(context)) as any).plan.revision).toBe(
      baseRevision,
    )
  })

  it("normalizes legacy tasks without mode to standard when reading", () => {
    const root = workspace()
    const file = path.join(root, "plan.json")
    fs.writeFileSync(
      file,
      JSON.stringify({
        title: "legacy",
        goal: "compatibility",
        status: "active",
        revision: 1,
        current_step: "s1",
        steps: [
          { id: "s1", title: "one", goal: "one", done_criteria: "one", status: "active", tasks: [task("s1_t1")] },
        ],
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      }),
    )
    expect(readPlanFileSync(file)?.steps[0]?.tasks[0]?.mode).toBe("standard")
  })

  it("keeps standard completion as approved-all", () => {
    const root = workspace()
    const step = {
      id: "s1",
      title: "one",
      goal: "one",
      done_criteria: "one",
      status: "active" as const,
      tasks: [task("s1_t1", "approved"), task("s1_t2", "reported")],
    }
    expect(isStepComplete(step, root)).toBe(false)
    step.tasks[1]!.status = "approved"
    expect(isStepComplete(step, root)).toBe(true)
  })

  it("rejects malformed candidate groups and duplicate proposal paths", () => {
    const base = {
      title: "candidate",
      goal: "compare",
      status: "active",
      revision: 1,
      current_step: "s1",
      steps: [
        {
          id: "s1",
          title: "one",
          goal: "one",
          done_criteria: "one",
          status: "active",
          tasks: [candidateTask("s1_t1"), candidateTask("s1_t2")],
        },
      ],
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    }
    expect(validatePlanFile({ ...base, steps: [{ ...base.steps[0], tasks: [candidateTask("s1_t1")] }] })).not.toEqual(
      [],
    )
    expect(
      validatePlanFile({
        ...base,
        steps: [
          {
            ...base.steps[0],
            tasks: [
              { ...candidateTask("s1_t1"), output_path: "same" },
              { ...candidateTask("s1_t2"), output_path: "same" },
            ],
          },
        ],
      }),
    ).toContain("plan.steps[0].tasks[1].output_path: duplicate candidate output path")
  })

  it("completes a candidate step only after selection and synthesis", () => {
    const root = workspace()
    const synthesis = path.join(root, "synthesis.md")
    fs.writeFileSync(synthesis, "combined")
    const step: PlanStep = {
      id: "s1",
      title: "one",
      goal: "one",
      done_criteria: "one",
      status: "active",
      tasks: [
        {
          ...candidateTask("s1_t1", "approved"),
          report: {
            status: "done",
            summary: "done",
            artifacts: ["proposal.md"],
            issues: [],
            reported_at: new Date().toISOString(),
            review_feedback: null,
          },
        },
        { ...candidateTask("s1_t2", "dismissed") },
        { ...candidateTask("s1_t3", "dismissed") },
      ],
      candidate_selection: {
        selected_task_id: "s1_t1",
        contributing_task_ids: ["s1_t2"],
        synthesis_artifact: synthesis,
        rationale: "best fit",
        selected_at: new Date().toISOString(),
      },
      candidate_discussion: { phase: "awaiting_main", ready_task_ids: ["s1_t1", "s1_t2", "s1_t3"] },
    }
    expect(isStepComplete(step, root)).toBe(true)
    expect(
      projectPlanSnapshot({
        title: "candidate",
        goal: "compare",
        status: "active",
        revision: 1,
        current_step: "s1",
        steps: [step],
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      }),
    ).toMatchObject({ steps: [{ candidate: { phase: "awaiting_main", ready: 3, total: 3 } }] })
  })
})
