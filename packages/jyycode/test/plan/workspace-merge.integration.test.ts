import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { execFileSync } from "node:child_process"
import { describe, expect, it } from "bun:test"
import { ChildWorkspace, type WorktreeAdapter } from "../../src/plan/child-workspace"
import { PlanProtocol } from "../../src/plan/protocol"
import { planFilePath } from "../../src/plan/schema"

function context(workspaceRoot: string, sessionId = "ses_main", mode: "single" | "multi" = "multi") {
  return { workspaceRoot, sessionId, mode }
}

function git(root: string, args: string[]) {
  execFileSync("git", args, { cwd: root, stdio: "pipe" })
}

function integrationInput() {
  return {
    title: "Unified merge integration",
    goal: "Verify the parent receives approved child changes",
    steps: [
      {
        title: "Implement",
        goal: "Implement the first change",
        done_criteria: "The child change is merged",
        tasks: [
          {
            title: "Add sentinel",
            goal: "Add a sentinel file",
            done_criteria: "The sentinel file exists",
            output_path: "out/step1.md",
          },
        ],
      },
      {
        title: "Verify",
        goal: "Verify the merged parent",
        done_criteria: "The verification child starts from the merged parent",
      },
    ],
  }
}

async function runIntegration(vcs: "git" | "none", failCleanupOnce = false) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `jyycode-merge-${vcs}-integration-`))
  const runtime = fs.mkdtempSync(path.join(os.tmpdir(), `jyycode-merge-${vcs}-runtime-`))
  let childRoot = ""
  let childOutput = ""
  try {
    fs.mkdirSync(path.join(root, "src"), { recursive: true })
    fs.writeFileSync(path.join(root, "src", "base.ts"), "export const base = true\n")
    fs.writeFileSync(path.join(root, "dirty.txt"), "dirty baseline\n")
    if (vcs === "git") {
      git(root, ["init", "--quiet"])
      git(root, ["config", "user.email", "merge-test@example.com"])
      git(root, ["config", "user.name", "Merge Test"])
      git(root, ["add", "src/base.ts"])
      git(root, ["commit", "--quiet", "-m", "base"])
    }

    let worktree: WorktreeAdapter | undefined
    if (vcs === "git") {
      worktree = {
        async makeWorktreeInfo(input) {
          return { name: input.name, directory: path.join(runtime, input.name) }
        },
        async createFromInfo(info) {
          git(root, ["worktree", "add", "--detach", "--quiet", info.directory, "HEAD"])
        },
        async remove(directory) {
          git(root, ["worktree", "remove", "--force", directory])
          return true
        },
      }
    }

    const childWorkspace = new ChildWorkspace({
      project: { root, vcs },
      runtimeRoot: runtime,
      ...(worktree ? { worktree } : {}),
    })
    if (failCleanupOnce) {
      const remove = childWorkspace.remove.bind(childWorkspace)
      let injected = false
      childWorkspace.remove = async (directory) => {
        if (!injected) {
          injected = true
          throw Object.assign(new Error("workspace is temporarily busy"), { code: "EBUSY" })
        }
        return remove(directory)
      }
    }
    const protocol = new PlanProtocol({
      childWorkspace,
      children: {
        async create(input) {
          childRoot = input.brief.workspace_root
          childOutput = input.brief.output_path
          return input.childSessionId
        },
        async start() {},
        async terminate() {},
      },
    })

    await protocol.create(context(root), integrationInput())
    const dispatched = await protocol.dispatch(context(root), { taskIds: ["s1_t1"], role: "general" })
    expect(dispatched).toMatchObject({ ok: true })
    if (!dispatched.ok) return
    expect(fs.readFileSync(path.join(childRoot, "dirty.txt"), "utf8")).toBe("dirty baseline\n")
    expect(fs.readFileSync(path.join(childRoot, "src", "base.ts"), "utf8")).toBe("export const base = true\n")

    fs.writeFileSync(path.join(root, "dirty.txt"), "parent-only edit\n")
    fs.mkdirSync(path.dirname(path.join(childRoot, "src", "merged.ts")), { recursive: true })
    fs.writeFileSync(path.join(childRoot, "src", "merged.ts"), "export const merged = true\n")
    fs.mkdirSync(path.dirname(childOutput), { recursive: true })
    fs.writeFileSync(childOutput, "step one report\n")
    const runId = dispatched.dispatched[0]!.run_id
    expect(
      await protocol.report(
        { ...context(childRoot, "child_s1_t1", "single"), runId },
        { run_id: runId, status: "done", summary: "ready", artifacts: [childOutput], issues: [] },
      ),
    ).toMatchObject({ ok: true, review: "pending_review" })
    const beforeReview = await protocol.read(context(root))
    expect(beforeReview).toMatchObject({ ok: true })
    if (!beforeReview.ok || !beforeReview.plan) return
    expect(
      await protocol.update(context(root), {
        revision: beforeReview.plan.revision,
        ops: [{ op: "review_task", stepId: "s1", taskId: "s1_t1", decision: "approve" }],
      }),
    ).toMatchObject({ ok: true })

    const merged = await protocol.merge(context(root), { task_id: "s1_t1" })
    if (failCleanupOnce) {
      expect(merged).toMatchObject({ ok: true, status: "merged", cleanup: "failed", cleanup_attempts: 1 })
      expect(fs.existsSync(childRoot)).toBe(true)
      const retried = await protocol.merge(context(root), { task_id: "s1_t1" })
      expect(retried).toMatchObject({
        ok: true,
        status: "already_merged",
        cleanup: "completed",
        cleanup_attempts: 2,
      })
    } else {
      expect(merged).toMatchObject({ ok: true, status: "merged", cleanup: "completed" })
    }
    expect(fs.readFileSync(path.join(root, "src", "merged.ts"), "utf8")).toBe("export const merged = true\n")
    expect(fs.readFileSync(path.join(root, "dirty.txt"), "utf8")).toBe("parent-only edit\n")
    expect(fs.existsSync(childRoot)).toBe(false)
    expect(fs.existsSync(path.join(runtime, `${path.basename(childRoot)}.baseline`))).toBe(false)
    const afterMerge = await protocol.read(context(root))
    expect(afterMerge).toMatchObject({ ok: true, plan: { current_step: "s2" } })
    if (afterMerge.ok && afterMerge.plan) expect(afterMerge.plan.steps[0].tasks[0].merge?.attempt).toBe(1)

    if (!afterMerge.ok || !afterMerge.plan) return
    const expanded = await protocol.update(context(root), {
      revision: afterMerge.plan.revision,
      ops: [
        {
          op: "add_task",
          stepId: "s2",
          task: { title: "Verify sentinel", goal: "Read the merged sentinel", done_criteria: "The sentinel is visible", output_path: "out/step2.md" },
        },
      ],
    })
    expect(expanded).toMatchObject({ ok: true, assigned_ids: { tasks: ["s2_t1"] } })
    const secondDispatch = await protocol.dispatch(context(root), { taskIds: ["s2_t1"], role: "general" })
    expect(secondDispatch).toMatchObject({ ok: true })
    expect(fs.readFileSync(path.join(childRoot, "src", "merged.ts"), "utf8")).toBe("export const merged = true\n")
    const plan = JSON.parse(fs.readFileSync(planFilePath(root, "ses_main"), "utf8"))
    expect(plan.steps[1].tasks[0].dispatch.workspace.baseline_directory).toBeTruthy()
    expect(await protocol.cancel(context(root), ["s2_t1"])).toMatchObject({ ok: true })
    expect(fs.existsSync(path.join(root, "src", "merged.ts"))).toBe(true)
  } finally {
    fs.rmSync(runtime, { recursive: true, force: true })
    fs.rmSync(root, { recursive: true, force: true })
  }
}

describe("unified workspace merge integration", () => {
  it("runs the complete non-Git flow and inherits merged files into the next Step", async () => {
    await runIntegration("none")
  })

  it("runs the complete real Git Worktree flow from a dirty parent", async () => {
    await runIntegration("git")
  })

  it("retries cleanup after an already-applied merge without repeating the merge", async () => {
    await runIntegration("none", true)
  })
})
