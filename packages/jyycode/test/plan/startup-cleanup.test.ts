import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { describe, expect, it } from "bun:test"
import { cleanupStartupPlanWorkspaces } from "../../src/plan/startup-cleanup"

function tempDirectory(prefix: string) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix))
}

function writePlan(workspaceRoot: string, task: Record<string, unknown>) {
  const planPath = path.join(workspaceRoot, ".jyycode", "plan", "ses_main", "plan.json")
  fs.mkdirSync(path.dirname(planPath), { recursive: true })
  fs.writeFileSync(
    planPath,
    JSON.stringify({
      title: "cleanup test",
      goal: "cleanup test",
      status: "active",
      revision: 1,
      current_step: "s1",
      created_at: "2026-08-09T00:00:00.000Z",
      updated_at: "2026-08-09T00:00:00.000Z",
      steps: [
        {
          id: "s1",
          title: "step",
          goal: "step",
          done_criteria: "done",
          status: "active",
          tasks: [task],
        },
      ],
    }),
  )
}

function activeTask(child: string, baseline: string, manifest: string, journal: string) {
  return {
    id: "s1_t1",
    title: "task",
    goal: "task",
    done_criteria: "done",
    output_path: "out.txt",
    mode: "standard",
    status: "running",
    dispatch: {
      run_id: "run__ses_main__s1_t1",
      child_session_id: "ses_child",
      dispatched_at: "2026-08-09T00:00:00.000Z",
      cancelled_at: null,
      lifecycle: "running",
      workspace: {
        mode: "snapshot",
        root: "project",
        directory: child,
        baseline_directory: baseline,
        baseline_manifest_path: manifest,
        baseline_manifest_hash: null,
        source_revision: null,
        created_at: "2026-08-09T00:00:00.000Z",
        cleanup: "on_success",
      },
    },
    report: null,
    merge: {
      status: "running",
      attempt: 1,
      applied_paths: [],
      conflicts: [],
      started_at: "2026-08-09T00:00:00.000Z",
      completed_at: null,
      target_fingerprint: null,
      cleanup: "not_started",
      journal_directory: journal,
    },
  }
}

describe("startup plan workspace cleanup", () => {
  it("removes orphaned child workspaces and merge journals", () => {
    const runtimeRoot = tempDirectory("jyycode-startup-runtime-")
    const workspaceRoot = tempDirectory("jyycode-startup-project-")
    const staleChild = path.join(runtimeRoot, "jyycode-ses_old-s1_t1-0123456789ab")
    const staleBaseline = path.join(runtimeRoot, "jyycode-ses_old-s1_t1-0123456789ab.baseline")
    const staleManifest = path.join(runtimeRoot, "jyycode-ses_old-s1_t1-0123456789ab.manifest.json")
    const staleJournal = path.join(runtimeRoot, ".jyycode-merge-0123456789abcdef")
    for (const directory of [staleChild, staleBaseline, staleJournal]) fs.mkdirSync(directory)
    fs.writeFileSync(staleManifest, "{}")

    const result = cleanupStartupPlanWorkspaces({ runtimeRoot, workspaceRoots: [workspaceRoot] })

    expect(result.removed.sort()).toEqual([staleBaseline, staleChild, staleJournal, staleManifest].sort())
    expect(fs.existsSync(staleChild)).toBe(false)
    expect(fs.existsSync(staleBaseline)).toBe(false)
    expect(fs.existsSync(staleManifest)).toBe(false)
    expect(fs.existsSync(staleJournal)).toBe(false)
  })

  it("preserves workspaces and journals referenced by active plans", () => {
    const runtimeRoot = tempDirectory("jyycode-startup-runtime-")
    const workspaceRoot = tempDirectory("jyycode-startup-project-")
    const child = path.join(runtimeRoot, "jyycode-ses_main-s1_t1-0123456789ab")
    const baseline = path.join(runtimeRoot, "jyycode-ses_main-s1_t1-0123456789ab.baseline")
    const manifest = path.join(runtimeRoot, "jyycode-ses_main-s1_t1-0123456789ab.manifest.json")
    const journal = path.join(runtimeRoot, ".jyycode-merge-0123456789abcdef")
    for (const directory of [child, baseline, journal]) fs.mkdirSync(directory)
    fs.writeFileSync(manifest, "{}")
    writePlan(workspaceRoot, activeTask(child, baseline, manifest, journal))

    const result = cleanupStartupPlanWorkspaces({ runtimeRoot, workspaceRoots: [workspaceRoot] })

    expect(result.removed).toEqual([])
    expect(result.preserved.sort()).toEqual([baseline, child, journal, manifest].sort())
    expect(fs.existsSync(child)).toBe(true)
    expect(fs.existsSync(baseline)).toBe(true)
    expect(fs.existsSync(manifest)).toBe(true)
    expect(fs.existsSync(journal)).toBe(true)
  })
})
