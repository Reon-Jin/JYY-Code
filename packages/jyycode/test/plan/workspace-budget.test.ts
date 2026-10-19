import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { describe, expect, it, spyOn } from "bun:test"
import { tmpdir } from "../fixture/fixture"
import { PlanProtocol } from "../../src/plan/protocol"
import { PlanStore } from "../../src/plan/store"
import { ChildWorkspace } from "../../src/plan/child-workspace"
import { buildSnapshotManifest } from "../../src/plan/snapshot-manifest"
import { directorySize } from "../../src/plan/workspace-sweeper"
import {
  directoryBytes,
  estimateSnapshotCost,
  preflightWorkspaceBudget,
  WorkspaceQuotaError,
} from "../../src/plan/workspace-budget"

function tempDirectory(prefix: string) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix))
}

describe("workspace snapshot budget", () => {
  it("estimates one shared baseline plus one writable copy per child", () => {
    const budget = estimateSnapshotCost({ manifest: { total_bytes: 100 }, taskCount: 3, currentBytes: 50 })
    expect(budget.baselineBytes).toBe(100)
    expect(budget.childBytes).toBe(100)
    expect(budget.estimatedNewBytes).toBe(400)
    expect(budget.projectedBytes).toBe(450)
  })

  it("counts hardlinked files once so shared baselines do not double-charge the quota", async () => {
    const root = tempDirectory("jyycode-budget-hardlink-")
    const original = path.join(root, "original.bin")
    fs.writeFileSync(original, Buffer.alloc(1024, 1))
    fs.linkSync(original, path.join(root, "linked.bin"))
    expect(await directoryBytes(root)).toBe(1024)
    expect(await directorySize(root)).toBe(1024)
  })

  it("scans nested runtime files concurrently with a bounded number of metadata requests", async () => {
    await using tmp = await tmpdir()
    for (let directory = 0; directory < 4; directory++) {
      const nested = path.join(tmp.path, String(directory))
      fs.mkdirSync(nested)
      for (let file = 0; file < 40; file++) fs.writeFileSync(path.join(nested, `${file}.txt`), "1234")
    }
    const stat = fs.promises.stat
    let active = 0
    let peak = 0
    const measured = spyOn(fs.promises, "stat").mockImplementation((async (...args: Parameters<typeof stat>) => {
      if (!String(args[0]).startsWith(tmp.path + path.sep)) return stat(...args)
      active++
      peak = Math.max(peak, active)
      try {
        return await stat(...args)
      } finally {
        active--
      }
    }) as typeof stat)
    try {
      expect(await directoryBytes(tmp.path)).toBe(640)
      expect(peak).toBeGreaterThan(1)
      expect(peak).toBeLessThanOrEqual(32)
    } finally {
      measured.mockRestore()
    }
  })

  it("uses exact inode IDs so Windows files are not mistaken for hardlinks", async () => {
    await using tmp = await tmpdir()
    fs.writeFileSync(path.join(tmp.path, "a.txt"), "1234")
    fs.writeFileSync(path.join(tmp.path, "b.txt"), "5678")
    const stat = fs.promises.stat
    const measured = spyOn(fs.promises, "stat").mockImplementation((async (...args: Parameters<typeof stat>) => {
      const value = await stat(...args)
      if (!String(args[0]).startsWith(tmp.path + path.sep)) return value
      const ino = String(args[0]).endsWith("a.txt") ? 2n ** 60n : 2n ** 60n + 1n
      return { ...value, ino: args[1]?.bigint ? ino : Number(ino) }
    }) as typeof stat)
    try {
      expect(await directoryBytes(tmp.path)).toBe(8)
    } finally {
      measured.mockRestore()
    }
  })

  it("stops scanning after reaching the quota threshold", async () => {
    await using tmp = await tmpdir()
    for (let file = 0; file < 160; file++) fs.writeFileSync(path.join(tmp.path, `${file}.txt`), "1234")
    const measured = spyOn(fs.promises, "stat")
    try {
      expect(await directoryBytes(tmp.path, 1)).toBeGreaterThanOrEqual(1)
      expect(measured.mock.calls.length).toBeLessThan(160)
    } finally {
      measured.mockRestore()
    }
  })

  it("continues accounting when a file disappears during traversal", async () => {
    await using tmp = await tmpdir()
    fs.writeFileSync(path.join(tmp.path, "a.txt"), "1234")
    fs.writeFileSync(path.join(tmp.path, "b.txt"), "5678")
    const stat = fs.promises.stat
    const measured = spyOn(fs.promises, "stat").mockImplementation((async (...args: Parameters<typeof stat>) => {
      if (String(args[0]) === path.join(tmp.path, "a.txt")) {
        throw Object.assign(new Error("removed during scan"), { code: "ENOENT" })
      }
      return stat(...args)
    }) as typeof stat)
    try {
      expect(await directoryBytes(tmp.path)).toBe(4)
    } finally {
      measured.mockRestore()
    }
  })

  it("interrupts quota scans when the dispatch signal aborts", async () => {
    await using tmp = await tmpdir()
    for (let file = 0; file < 160; file++) fs.writeFileSync(path.join(tmp.path, `${file}.txt`), "source")
    const controller = new AbortController()
    const stat = fs.promises.stat
    let requests = 0
    const measured = spyOn(fs.promises, "stat").mockImplementation((async (...args: Parameters<typeof stat>) => {
      if (String(args[0]).startsWith(tmp.path + path.sep)) {
        requests++
        controller.abort(new Error("dispatch deadline exceeded"))
      }
      return stat(...args)
    }) as typeof stat)
    try {
      await expect(
        preflightWorkspaceBudget({
          runtimeRoot: tmp.path,
          manifest: { total_bytes: 1 },
          taskCount: 1,
          signal: controller.signal,
        }),
      ).rejects.toThrow("dispatch deadline exceeded")
      expect(requests).toBeGreaterThan(0)
      expect(requests).toBeLessThanOrEqual(32)
    } finally {
      measured.mockRestore()
    }
  })

  it("does not launch children or mutate tasks when dispatch expires during preflight", async () => {
    await using root = await tmpdir()
    await using runtime = await tmpdir()
    const controller = new AbortController()
    class ExpiringWorkspace extends ChildWorkspace {
      override async preflight(...args: Parameters<ChildWorkspace["preflight"]>) {
        const result = await super.preflight(...args)
        controller.abort(new Error("dispatch deadline exceeded"))
        return result
      }
    }
    let childrenCreated = 0
    const protocol = new PlanProtocol({
      store: new PlanStore(),
      childWorkspace: new ExpiringWorkspace({ project: { root: root.path, vcs: "none" }, runtimeRoot: runtime.path }),
      children: {
        async create() {
          childrenCreated++
          return "child"
        },
        async start() {},
        async terminate() {},
      },
    })
    const context = { workspaceRoot: root.path, sessionId: "ses_expired", mode: "multi" as const }
    await protocol.create(context, {
      title: "expiry",
      goal: "expiry",
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
    const result = await protocol.dispatch(
      { ...context, abortSignal: controller.signal },
      { taskIds: ["s1_t1"], role: "general" },
    )
    expect(result.ok).toBe(false)
    expect(childrenCreated).toBe(0)
    const plan = await protocol.read(context)
    expect(plan.ok && plan.plan?.steps[0]?.tasks[0]?.status).toBe("pending")
  })

  it("rejects a quota before any workspace is created", async () => {
    const runtimeRoot = tempDirectory("jyycode-budget-runtime-")
    const root = tempDirectory("jyycode-budget-project-")
    fs.writeFileSync(path.join(root, "source.txt"), "source")
    const manifest = await buildSnapshotManifest({ root })
    await expect(
      preflightWorkspaceBudget({
        runtimeRoot,
        manifest,
        taskCount: 3,
        hardLimitBytes: 1,
      }),
    ).rejects.toBeInstanceOf(WorkspaceQuotaError)
    expect(fs.readdirSync(runtimeRoot)).toEqual([])
  })

  it("rejects snapshot dispatch before the durable task state changes", async () => {
    const root = tempDirectory("jyycode-budget-protocol-project-")
    const runtimeRoot = tempDirectory("jyycode-budget-protocol-runtime-")
    fs.writeFileSync(path.join(root, "source.txt"), "source")
    const protocol = new PlanProtocol({
      store: new PlanStore(),
      childWorkspace: new ChildWorkspace({
        project: { root, vcs: "none" },
        runtimeRoot,
        workspaceBudget: { hardLimitBytes: 1 },
      }),
      children: {
        async create() {
          throw new Error("child creation must not run")
        },
        async start() {},
        async terminate() {},
      },
    })
    const context = { workspaceRoot: root, sessionId: "ses_main", mode: "multi" as const }
    const created = await protocol.create(context, {
      title: "budget",
      goal: "budget",
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
    expect(created).toMatchObject({ ok: true })
    const result = await protocol.dispatch(context, { taskIds: ["s1_t1"], role: "general" })
    expect(result).toMatchObject({ ok: false, error: { code: "WORKSPACE_QUOTA_EXCEEDED" } })
    const plan = await protocol.read(context)
    expect(plan.ok && plan.plan?.steps[0]?.tasks[0]?.status).toBe("pending")
    expect(fs.readdirSync(runtimeRoot)).toEqual([])
  })
})
