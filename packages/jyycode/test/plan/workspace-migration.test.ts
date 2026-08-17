import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { describe, expect, it } from "bun:test"
import { WorkspaceLeaseStore } from "../../src/plan/workspace-lease"
import { applyWorkspaceMigration, inspectWorkspaceStorage } from "../../src/plan/workspace-sweeper"

function tempDirectory(prefix: string) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix))
}

function manifest(directory: string, rootSessionId: string, taskId: string) {
  fs.writeFileSync(
    `${directory}.manifest.json`,
    JSON.stringify({
      version: 1,
      root_session_id: rootSessionId,
      task_id: taskId,
      name: path.basename(directory),
      entries: [],
    }),
  )
}

function plan(workspaceRoot: string, directory: string) {
  const planPath = path.join(workspaceRoot, ".jyycode", "plan", "ses_main", "plan.json")
  fs.mkdirSync(path.dirname(planPath), { recursive: true })
  fs.writeFileSync(
    planPath,
    JSON.stringify({
      title: "migration",
      goal: "migration",
      status: "done",
      revision: 1,
      current_step: null,
      created_at: "2026-08-09T00:00:00.000Z",
      updated_at: "2026-08-09T00:00:00.000Z",
      steps: [
        {
          id: "s1",
          title: "step",
          goal: "step",
          done_criteria: "done",
          status: "done",
          tasks: [
            {
              id: "s1_t1",
              title: "task",
              goal: "task",
              done_criteria: "done",
              output_path: null,
              status: "approved",
              dispatch: {
                run_id: "run__ses_main__s1_t1",
                child_session_id: "ses_child",
                dispatched_at: "2026-08-09T00:00:00.000Z",
                cancelled_at: null,
                lifecycle: "settled",
                workspace: {
                  mode: "snapshot",
                  root: "project",
                  directory,
                  created_at: "2026-08-09T00:00:00.000Z",
                  cleanup: "on_success",
                },
              },
              report: null,
              merge: {
                status: "merged",
                attempt: 1,
                applied_paths: [],
                conflicts: [],
                started_at: "2026-08-09T00:00:00.000Z",
                completed_at: "2026-08-09T00:00:00.000Z",
                target_fingerprint: null,
                cleanup: "failed",
                cleanup_record: {
                  state: "failed",
                  attempts: 1,
                  updated_at: "2026-08-09T00:00:00.000Z",
                },
              },
            },
          ],
        },
      ],
    }),
  )
}

describe("plan workspace migration inventory", () => {
  it("classifies active, failed, orphan, terminal references, and unknown entries", async () => {
    const runtimeRoot = tempDirectory("jyycode-migration-runtime-")
    const projectRoot = tempDirectory("jyycode-migration-project-")
    const now = 5_000
    const active = path.join(runtimeRoot, "jyycode-ses_active-s4_t1-aaaaaaaaaaaa")
    const failed = path.join(runtimeRoot, "jyycode-ses_failed-s1_t1-bbbbbbbbbbbb")
    const orphan = path.join(runtimeRoot, "jyycode-ses_orphan-s1_t1-cccccccccccc")
    const terminal = path.join(runtimeRoot, "jyycode-ses_terminal-s1_t1-dddddddddddd")
    const unknown = path.join(runtimeRoot, "mystery-workspace")
    for (const directory of [active, failed, orphan, terminal, unknown]) fs.mkdirSync(directory)
    fs.utimesSync(terminal, new Date(0), new Date(0))
    manifest(active, "ses_active", "s4_t1")
    manifest(failed, "ses_failed", "s1_t1")
    manifest(orphan, "ses_orphan", "s1_t1")
    manifest(terminal, "ses_main", "s1_t1")
    plan(projectRoot, terminal)
    const store = new WorkspaceLeaseStore({ runtimeRoot, now: () => 0, ttlMs: 10_000 })
    store.create({
      workspace_directory: active,
      root_session_id: "ses_active",
      task_id: "s4_t1",
      run_id: "run_active",
      session_id: "ses_child_active",
    })
    const staleStore = new WorkspaceLeaseStore({ runtimeRoot, now: () => 0, ttlMs: 10 })
    staleStore.create({
      workspace_directory: failed,
      root_session_id: "ses_failed",
      task_id: "s1_t1",
      run_id: "run_failed",
      session_id: "ses_missing",
    })
    staleStore.create({
      workspace_directory: orphan,
      root_session_id: "ses_orphan",
      task_id: "s1_t1",
      run_id: "run_orphan",
      session_id: "ses_missing",
    })
    fs.writeFileSync(
      path.join(runtimeRoot, ".jyycode-cleanup-queue.json"),
      JSON.stringify({
        [`ses_failed\0s1_t1\0${path.resolve(failed)}`]: {
          state: "failed",
          attempts: 1,
          updated_at: new Date(0).toISOString(),
        },
      }),
    )

    const report = await inspectWorkspaceStorage({
      project: "global",
      runtimeRoot,
      planRoots: [projectRoot],
      now,
      orphanGraceMs: 0,
      sessionIds: ["ses_active"],
    })
    expect(report.categories.active.map((item) => item.name)).toEqual([path.basename(active)])
    expect(report.categories.cleanup_failed.map((item) => item.name)).toEqual([path.basename(failed)])
    expect(report.categories.orphan.map((item) => item.name)).toEqual([path.basename(orphan)])
    expect(report.categories.terminal_reference.map((item) => item.name)).toEqual([path.basename(terminal)])
    expect(report.categories.unknown.map((item) => item.name)).toEqual([path.basename(unknown)])
    expect(
      report.items
        .filter((item) => item.eligible)
        .map((item) => item.name)
        .sort(),
    ).toEqual([path.basename(failed), path.basename(orphan), path.basename(terminal)].sort())
    expect(fs.existsSync(report.index_path)).toBe(true)
  })

  it("revalidates cleanup IDs and quarantines instead of deleting", async () => {
    const runtimeRoot = tempDirectory("jyycode-migration-apply-")
    const directory = path.join(runtimeRoot, "jyycode-ses_old-s1_t1-eeeeeeeeeeee")
    fs.mkdirSync(directory)
    manifest(directory, "ses_old", "s1_t1")
    const store = new WorkspaceLeaseStore({ runtimeRoot, now: () => 0, ttlMs: 10 })
    store.create({
      workspace_directory: directory,
      root_session_id: "ses_old",
      task_id: "s1_t1",
      run_id: "run_old",
      session_id: "ses_missing",
    })
    const report = await inspectWorkspaceStorage({ runtimeRoot, now: 5_000, orphanGraceMs: 0 })
    const item = report.categories.orphan[0]!
    const applied = await applyWorkspaceMigration({
      runtimeRoot,
      now: 5_000,
      orphanGraceMs: 0,
      cleanupIds: [item.cleanup_id],
    })
    expect(applied.applied).toEqual([item.cleanup_id])
    expect(fs.existsSync(directory)).toBe(false)
    expect(fs.readdirSync(path.join(runtimeRoot, ".quarantine")).some((name) => name.includes(item.cleanup_id))).toBe(
      true,
    )
  })
})
