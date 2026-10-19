import { describe, expect, test } from "bun:test"
import fs from "node:fs"
import path from "node:path"
import { tmpdir } from "../fixture/fixture"
import { PlanProtocol } from "../../src/plan/protocol"
import { PlanStore } from "../../src/plan/store"
import { ChildWorkspace } from "../../src/plan/child-workspace"

const task = (name: string, inputs: Array<{ path: string; from_task?: string }> = []) => ({
  title: name,
  goal: name,
  done_criteria: `${name} exists`,
  output_path: `${name}.md`,
  inputs,
})
const step = (tasks: ReturnType<typeof task>[]) => ({
  title: "Work",
  goal: "Work",
  done_criteria: "All outputs ready",
  tasks,
})

describe("Step task inputs", () => {
  for (const producer of ["s1_t1", "s2_t1", "s9_t1"]) {
    test(`rejects same-Step, future or unknown producer ${producer}`, async () => {
      await using dir = await tmpdir()
      const protocol = new PlanProtocol({ store: new PlanStore() })
      const result = await protocol.create(
        { workspaceRoot: dir.path, sessionId: "ses_inputs", mode: "multi" },
        {
          title: "Plan",
          goal: "Independent tasks",
          steps: [step([task("one"), task("two", [{ from_task: producer, path: "one.md" }])]), step([task("later")])],
        },
      )
      expect(result).toMatchObject({ ok: false, error: { code: "TASK_DEPENDENCY_INVALID" } })
    })
  }

  test("preserves declared inputs and accepts multiple independent consumers in a later Step", async () => {
    await using dir = await tmpdir()
    const protocol = new PlanProtocol({ store: new PlanStore() })
    const ctx = { workspaceRoot: dir.path, sessionId: "ses_inputs", mode: "multi" as const }
    const inputs = [{ from_task: "s1_t1", path: "research.md" }]
    expect(
      await protocol.create(ctx, {
        title: "Plan",
        goal: "Parallel consumers",
        steps: [step([task("research")]), step([task("web", inputs), task("pdf", inputs), task("video", inputs)])],
      }),
    ).toMatchObject({ ok: true })
    const read = await protocol.read(ctx)
    if (!read.ok || !read.plan) throw new Error("plan missing")
    expect(read.plan.steps[1]!.tasks.map((item) => item.inputs)).toEqual([inputs, inputs, inputs])
  })

  test("rejects a dependency added by Plan_update and rolls back the task edit", async () => {
    await using dir = await tmpdir()
    const protocol = new PlanProtocol({ store: new PlanStore() })
    const ctx = { workspaceRoot: dir.path, sessionId: "ses_inputs", mode: "multi" as const }
    expect(
      await protocol.create(ctx, {
        title: "Plan",
        goal: "Parallel",
        steps: [step([task("one"), task("two")]), step([])],
      }),
    ).toMatchObject({ ok: true })
    expect(
      await protocol.update(ctx, {
        revision: 1,
        ops: [
          {
            op: "edit_task",
            stepId: "s1",
            taskId: "s1_t2",
            fields: { inputs: [{ from_task: "s1_t1", path: "one.md" }] },
          },
        ],
      }),
    ).toMatchObject({ ok: false, error: { code: "TASK_DEPENDENCY_INVALID" } })
    const read = await protocol.read(ctx)
    if (!read.ok || !read.plan) throw new Error("plan missing")
    expect(read.plan.revision).toBe(1)
    expect(read.plan.steps[0]!.tasks[1]!.inputs).toEqual([])
  })

  test("fails before launching any child when an input is missing", async () => {
    await using dir = await tmpdir()
    const starts: string[] = []
    const protocol = new PlanProtocol({
      store: new PlanStore(),
      children: {
        async create(input) {
          starts.push(input.taskId)
          return input.childSessionId
        },
        async start() {},
        async terminate() {},
      },
    })
    const ctx = { workspaceRoot: dir.path, sessionId: "ses_inputs", mode: "multi" as const }
    expect(
      await protocol.create(ctx, {
        title: "Plan",
        goal: "Parallel",
        steps: [step([task("one", [{ path: "missing.md" }]), task("two")]), step([])],
      }),
    ).toMatchObject({ ok: true })
    expect(await protocol.dispatch(ctx, { taskIds: ["s1_t1", "s1_t2"], role: "general" })).toMatchObject({
      ok: false,
      error: { code: "TASK_INPUT_MISSING" },
    })
    expect(starts).toEqual([])
  })

  test("does not serialize independent tasks sharing an existing project input", async () => {
    await using dir = await tmpdir()
    await using runtime = await tmpdir()
    fs.writeFileSync(path.join(dir.path, "requirements.md"), "Shared input")
    let release!: () => void
    const wait = new Promise<void>((resolve) => {
      release = resolve
    })
    const starts: string[] = []
    const protocol = new PlanProtocol({
      store: new PlanStore(),
      childWorkspace: new ChildWorkspace({ project: { root: dir.path, vcs: "none" }, runtimeRoot: runtime.path }),
      children: {
        async create(input) {
          return input.childSessionId
        },
        async start(input) {
          expect(fs.readFileSync(path.join(input.brief.workspace_root, "requirements.md"), "utf8")).toBe("Shared input")
          starts.push(input.taskId)
          await wait
        },
        async terminate() {},
      },
    })
    const ctx = { workspaceRoot: dir.path, sessionId: "ses_inputs", mode: "multi" as const }
    expect(
      await protocol.create(ctx, {
        title: "Plan",
        goal: "Parallel",
        steps: [step(["web", "pdf", "video"].map((name) => task(name, [{ path: "requirements.md" }]))), step([])],
      }),
    ).toMatchObject({ ok: true })
    const dispatching = protocol.dispatch(ctx, { taskIds: ["s1_t1", "s1_t2", "s1_t3"], role: "general" })
    try {
      const deadline = Date.now() + 2000
      while (starts.length < 3 && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 10))
      expect(starts).toHaveLength(3)
    } finally {
      release()
    }
    expect(await dispatching).toMatchObject({ ok: true })
  })

  test("keeps concurrent dispatch callers on one Step baseline without waiting for sibling completion", async () => {
    await using dir = await tmpdir()
    await using runtime = await tmpdir()
    fs.writeFileSync(path.join(dir.path, "requirements.md"), "Shared input")
    let release!: () => void
    const wait = new Promise<void>((resolve) => {
      release = resolve
    })
    const starts: string[] = []
    const makeProtocol = () =>
      new PlanProtocol({
        store: new PlanStore(),
        childWorkspace: new ChildWorkspace({ project: { root: dir.path, vcs: "none" }, runtimeRoot: runtime.path }),
        children: {
          async create(input) {
            return input.childSessionId
          },
          async start(input) {
            starts.push(input.taskId)
            await wait
          },
          async terminate() {},
        },
      })
    const first = makeProtocol()
    const second = makeProtocol()
    const ctx = { workspaceRoot: dir.path, sessionId: "ses_batches", mode: "multi" as const }
    expect(
      await first.create(ctx, { goal: "Independent batches", steps: [step([task("one"), task("two")]), step([])] }),
    ).toMatchObject({ ok: true })
    const dispatching = [
      first.dispatch(ctx, { taskIds: ["s1_t1"], role: "general" }),
      second.dispatch(ctx, { taskIds: ["s1_t2"], role: "general" }),
    ]
    try {
      const deadline = Date.now() + 3000
      while (starts.length < 2 && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 10))
      expect(starts).toHaveLength(2)
      const read = await first.read(ctx)
      if (!read.ok || !read.plan) throw new Error("plan missing")
      const baseline = read.plan.steps[0]!.baseline!
      expect(read.plan.steps[0]!.tasks.map((item) => item.dispatch!.workspace!.source_manifest_hash)).toEqual([
        baseline.source_manifest_hash,
        baseline.source_manifest_hash,
      ])
    } finally {
      release()
    }
    expect(await Promise.all(dispatching)).toMatchObject([{ ok: true }, { ok: true }])
  })

  for (const filename of [
    "../peer/result.md",
    "C:\\peer\\result.md",
    "C:peer-result.md",
    "/peer/result.md",
    "\\\\server\\share\\result.md",
  ]) {
    test(`rejects an input outside its workspace: ${filename}`, async () => {
      await using dir = await tmpdir()
      const protocol = new PlanProtocol({ store: new PlanStore() })
      expect(
        await protocol.create(
          { workspaceRoot: dir.path, sessionId: "ses_escape", mode: "multi" },
          {
            goal: "Isolated inputs",
            steps: [step([task("one", [{ path: filename }])]), step([])],
          },
        ),
      ).toMatchObject({ ok: false, error: { code: "TASK_DEPENDENCY_INVALID" } })
    })
  }
})
