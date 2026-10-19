import fs from "node:fs"
import path from "node:path"
import { describe, expect, it } from "bun:test"
import { tmpdir } from "../fixture/fixture"
import { ChildWorkspace } from "../../src/plan/child-workspace"
import { PlanProtocol } from "../../src/plan/protocol"
import { PlanStore } from "../../src/plan/store"
import { PlanWorkspaceMaintenance } from "../../src/plan/workspace-maintenance"
import { WorkspaceLeaseStore } from "../../src/plan/workspace-lease"
import { snapshotRuntimeRoot } from "../../src/plan/workspace-storage"
import { planFilePath, readPlanFileSync } from "../../src/plan/schema"

const DAY = 24 * 60 * 60 * 1000
const OLD_CHILD = "jyycode-ses_old-s1_t1-0123456789ab"
const BASELINE = "baseline-" + "a".repeat(24)
const emptyContext = () => ({ planRoots: [], liveSessionIds: new Set<string>() })

function artifact(root: string, name: string) {
  const directory = path.join(root, name)
  fs.mkdirSync(directory, { recursive: true })
  fs.writeFileSync(path.join(directory, "data.txt"), "temporary")
  return directory
}

describe("project workspace maintenance", () => {
  it("quarantines old unleased children, orphan baselines and journals in both layouts", async () => {
    await using data = await tmpdir()
    await using project = await tmpdir()
    const global = path.join(data.path, "plan-workspaces", "global")
    const isolated = snapshotRuntimeRoot(data.path, project.path)
    const child = artifact(global, OLD_CHILD)
    const baseline = artifact(global, BASELINE)
    const journal = artifact(isolated, ".jyycode-merge-" + "b".repeat(16))
    const maintenance = new PlanWorkspaceMaintenance({
      dataRoot: data.path,
      now: () => Date.now() + 2 * DAY,
      context: emptyContext,
    })
    const dry = await maintenance.scan({ dryRun: true })
    expect(dry.failures).toEqual([])
    expect(dry.quarantined.sort()).toEqual([child, baseline, journal].sort())
    expect(fs.existsSync(child)).toBe(true)
    const applied = await maintenance.scan()
    expect(applied.failures).toEqual([])
    expect(fs.existsSync(child)).toBe(false)
    expect(fs.existsSync(baseline)).toBe(false)
    expect(fs.existsSync(journal)).toBe(false)
    expect(fs.existsSync(path.join(global, ".quarantine"))).toBe(true)
  })

  it("preserves recent work, unknown files and live activations without a lease", async () => {
    await using data = await tmpdir()
    const root = path.join(data.path, "plan-workspaces", "global")
    const directory = artifact(root, OLD_CHILD)
    const unknown = artifact(root, "user-notes")
    const recent = new PlanWorkspaceMaintenance({ dataRoot: data.path, context: emptyContext })
    expect((await recent.scan()).quarantined).toEqual([])
    const live = new PlanWorkspaceMaintenance({
      dataRoot: data.path,
      now: () => Date.now() + 2 * DAY,
      context: () => ({ ...emptyContext(), liveWorkspaceDirectories: new Set([directory]) }),
    })
    expect((await live.scan()).quarantined).toEqual([])
    expect(fs.existsSync(directory)).toBe(true)
    expect(fs.existsSync(unknown)).toBe(true)
  })

  it("preserves reported work and its shared baseline even after the lease is gone", async () => {
    await using data = await tmpdir()
    await using project = await tmpdir()
    const runtimeRoot = path.join(data.path, "plan-workspaces", "global")
    const manager = new ChildWorkspace({ project: { root: project.path, vcs: "none" }, runtimeRoot })
    const protocol = new PlanProtocol({
      store: new PlanStore(),
      childWorkspace: manager,
      children: {
        async create() {
          return "ses_child"
        },
        async start() {},
        async terminate() {},
      },
    })
    const context = { workspaceRoot: project.path, sessionId: "ses_main", mode: "multi" as const }
    await protocol.create(context, {
      title: "test",
      goal: "test",
      steps: [
        {
          title: "step",
          goal: "step",
          done_criteria: "done",
          tasks: [{ title: "task", goal: "task", done_criteria: "done", output_path: "out.txt" }],
        },
        { title: "next", goal: "next", done_criteria: "done" },
      ],
    })
    await protocol.dispatch(context, { taskIds: ["s1_t1"], role: "general" })
    const plan = readPlanFileSync(planFilePath(project.path, "ses_main"))!
    const task = plan.steps[0].tasks[0]
    task.status = "reported"
    fs.writeFileSync(planFilePath(project.path, "ses_main"), JSON.stringify(plan))
    const directory = task.dispatch!.workspace!.directory!
    const baseline = task.dispatch!.workspace!.baseline_directory!
    const maintenance = new PlanWorkspaceMaintenance({
      dataRoot: data.path,
      now: () => Date.now() + 30 * DAY,
      context: () => ({ planRoots: [project.path], liveSessionIds: new Set() }),
    })
    const result = await maintenance.scan()
    expect(result.failures).toEqual([])
    expect(result.quarantined).toEqual([])
    expect(fs.existsSync(directory)).toBe(true)
    expect(fs.existsSync(baseline)).toBe(true)
  })

  it("retains shared baselines until the last child sidecar is gone", async () => {
    await using data = await tmpdir()
    const root = path.join(data.path, "plan-workspaces", "global")
    const baseline = artifact(root, BASELINE)
    const child = artifact(root, OLD_CHILD)
    fs.writeFileSync(child + ".manifest.json", JSON.stringify({ baseline_id: BASELINE }))
    const maintenance = new PlanWorkspaceMaintenance({
      dataRoot: data.path,
      now: () => Date.now() + 2 * DAY,
      context: emptyContext,
    })
    const first = await maintenance.scan()
    expect(first.quarantined).toContain(child)
    expect(fs.existsSync(baseline)).toBe(true)
    expect((await maintenance.scan()).quarantined).toContain(baseline)
  })

  it("expires failed tasks after a day even when their merge record is still pending", async () => {
    await using data = await tmpdir()
    await using project = await tmpdir()
    const runtimeRoot = path.join(data.path, "plan-workspaces", "global")
    const manager = new ChildWorkspace({ project: { root: project.path, vcs: "none" }, runtimeRoot })
    const protocol = new PlanProtocol({
      store: new PlanStore(),
      childWorkspace: manager,
      children: {
        async create() {
          return "ses_failed_child"
        },
        async start() {},
        async terminate() {},
      },
    })
    const context = { workspaceRoot: project.path, sessionId: "ses_failed", mode: "multi" as const }
    await protocol.create(context, {
      title: "test",
      goal: "test",
      steps: [
        {
          title: "step",
          goal: "step",
          done_criteria: "done",
          tasks: [{ title: "task", goal: "task", done_criteria: "done", output_path: "out.txt" }],
        },
        { title: "next", goal: "next", done_criteria: "done" },
      ],
    })
    await protocol.dispatch(context, { taskIds: ["s1_t1"], role: "general" })
    const planPath = planFilePath(project.path, "ses_failed")
    const plan = readPlanFileSync(planPath)!
    const task = plan.steps[0].tasks[0]
    task.status = "rejected"
    expect(task.merge?.status).toBe("pending")
    fs.writeFileSync(planPath, JSON.stringify(plan))
    let now = Date.now()
    const maintenance = new PlanWorkspaceMaintenance({
      dataRoot: data.path,
      now: () => now,
      context: () => ({ planRoots: [project.path], liveSessionIds: new Set() }),
    })
    expect((await maintenance.scan()).quarantined).toEqual([])
    now += 2 * DAY
    expect((await maintenance.scan()).quarantined).toContain(task.dispatch!.workspace!.directory!)
  })

  it("reclaims stale sidecars whose child is gone so their baselines cannot stay pinned forever", async () => {
    await using data = await tmpdir()
    const root = path.join(data.path, "plan-workspaces", "global")
    const baseline = artifact(root, BASELINE)
    const sidecar = path.join(root, OLD_CHILD + ".manifest.json")
    fs.writeFileSync(sidecar, JSON.stringify({ baseline_id: BASELINE }))
    const maintenance = new PlanWorkspaceMaintenance({
      dataRoot: data.path,
      now: () => Date.now() + 2 * DAY,
      context: emptyContext,
    })
    expect((await maintenance.scan()).quarantined).toContain(sidecar)
    expect(fs.existsSync(baseline)).toBe(true)
    expect((await maintenance.scan()).quarantined).toContain(baseline)
  })

  it("eventually reaches old garbage behind more than one batch of protected artifacts", async () => {
    await using data = await tmpdir()
    const root = path.join(data.path, "plan-workspaces", "global")
    const live = new Set<string>()
    for (let index = 0; index < 21; index++)
      live.add(artifact(root, `baseline-${index.toString(16).padStart(24, "0")}`))
    const garbage = artifact(root, OLD_CHILD)
    const maintenance = new PlanWorkspaceMaintenance({
      dataRoot: data.path,
      now: () => Date.now() + 2 * DAY,
      context: () => ({ ...emptyContext(), liveWorkspaceDirectories: live }),
    })
    expect((await maintenance.scan()).quarantined).toEqual([])
    expect((await maintenance.scan()).quarantined).toContain(garbage)
    for (const directory of live) expect(fs.existsSync(directory)).toBe(true)
  })

  it("purges expired quarantine but preserves a directory still referenced by a live activation", async () => {
    await using data = await tmpdir()
    const root = path.join(data.path, "plan-workspaces", "global")
    const expired = artifact(path.join(root, ".quarantine"), "expired")
    const protectedDirectory = artifact(path.join(root, ".quarantine"), "protected")
    const maintenance = new PlanWorkspaceMaintenance({
      dataRoot: data.path,
      now: () => Date.now() + 10 * DAY,
      context: () => ({ ...emptyContext(), liveWorkspaceDirectories: new Set([protectedDirectory]) }),
    })
    expect((await maintenance.scan({ dryRun: true })).purged).toContain(expired)
    expect(fs.existsSync(expired)).toBe(true)
    const result = await maintenance.scan()
    expect(result.failures).toEqual([])
    expect(result.purged).toContain(expired)
    expect(fs.existsSync(expired)).toBe(false)
    expect(fs.existsSync(protectedDirectory)).toBe(true)
  })

  it("keeps a failed child's lease through its retention period and reclaims it after restart", async () => {
    await using data = await tmpdir()
    const root = path.join(data.path, "plan-workspaces", "global")
    const directory = artifact(root, OLD_CHILD)
    let now = Date.now()
    const leases = new WorkspaceLeaseStore({ runtimeRoot: root, now: () => now })
    leases.create({
      workspace_directory: directory,
      root_session_id: "ses_old",
      task_id: "s1_t1",
      run_id: "old",
      session_id: "ses_child",
    })
    fs.writeFileSync(
      directory + ".manifest.json",
      JSON.stringify({ root_session_id: "ses_old", task_id: "s1_t1", name: OLD_CHILD }),
    )
    const finished = leases.finish(directory, "failure", DAY)!
    expect(finished.terminal_state).toBe("failure")
    now += DAY / 2
    const retained = new PlanWorkspaceMaintenance({ dataRoot: data.path, now: () => now, context: emptyContext })
    expect((await retained.scan()).roots[0].sweep.preserved).toContain(directory)
    now += DAY
    const restarted = new PlanWorkspaceMaintenance({ dataRoot: data.path, now: () => now, context: emptyContext })
    expect((await restarted.scan()).roots[0].sweep.quarantined).toContain(directory)
    expect(fs.existsSync(directory)).toBe(false)
  })

  it("does not reclaim anything when database state is unavailable or a plan is corrupt", async () => {
    await using data = await tmpdir()
    await using project = await tmpdir()
    const directory = artifact(path.join(data.path, "plan-workspaces", "global"), OLD_CHILD)
    const unavailable = new PlanWorkspaceMaintenance({
      dataRoot: data.path,
      now: () => Date.now() + 2 * DAY,
      context: () => {
        throw new Error("database busy")
      },
    })
    expect((await unavailable.scan()).failures.length).toBe(1)
    const plan = planFilePath(project.path, "ses_bad")
    fs.mkdirSync(path.dirname(plan), { recursive: true })
    fs.writeFileSync(plan, "invalid JSON")
    const corrupt = new PlanWorkspaceMaintenance({
      dataRoot: data.path,
      now: () => Date.now() + 2 * DAY,
      context: () => ({ planRoots: [project.path], liveSessionIds: new Set() }),
    })
    expect((await corrupt.scan()).failures.length).toBe(1)
    expect(fs.existsSync(directory)).toBe(true)
  })

  it("never follows a runtime root redirected outside managed storage", async () => {
    await using data = await tmpdir()
    await using outside = await tmpdir()
    fs.mkdirSync(path.join(data.path, "plan-workspaces"))
    fs.symlinkSync(
      outside.path,
      path.join(data.path, "plan-workspaces", "global"),
      process.platform === "win32" ? "junction" : "dir",
    )
    const keep = artifact(outside.path, OLD_CHILD)
    const maintenance = new PlanWorkspaceMaintenance({
      dataRoot: data.path,
      now: () => Date.now() + 2 * DAY,
      context: emptyContext,
    })
    expect((await maintenance.scan()).failures.length).toBe(1)
    expect(fs.existsSync(keep)).toBe(true)
  })
})
