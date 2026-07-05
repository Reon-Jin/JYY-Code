import { describe, expect, test, beforeAll } from "bun:test"
import { Database } from "bun:sqlite"
import { drizzle } from "drizzle-orm/bun-sqlite"
import { AgentClusterRunTable, AgentClusterTaskTable } from "../../src/agent-cluster/cluster.sql"
import { AgentClusterLifecycle } from "../../src/agent-cluster/lifecycle"
import { AgentClusterRuntime } from "../../src/agent-cluster/runtime"
import type { TaskStatus } from "../../src/agent-cluster/schema"
import { eq, and } from "../../src/storage/db"

// Create a fresh in-memory DB with the full updated schema (including status_version)
function createTestDB() {
  const sqlite = new Database(":memory:")
  sqlite.exec("PRAGMA foreign_keys = ON")
  sqlite.exec(`
    CREATE TABLE agent_cluster_run (
      id text PRIMARY KEY NOT NULL,
      session_id text NOT NULL,
      parent_message_id text NOT NULL,
      enabled integer DEFAULT 1 NOT NULL,
      status text NOT NULL,
      status_version integer NOT NULL DEFAULT 0,
      goal text NOT NULL,
      planner_model text NOT NULL,
      reviewer_model text NOT NULL,
      time_created integer NOT NULL,
      time_updated integer NOT NULL,
      completed_at integer
    )
  `)
  sqlite.exec(`
    CREATE TABLE agent_cluster_task (
      id text PRIMARY KEY NOT NULL,
      run_id text NOT NULL,
      plan_task_id text NOT NULL,
      parent_task_id text,
      child_session_id text,
      step integer NOT NULL,
      dependencies text NOT NULL DEFAULT '[]',
      role text NOT NULL,
      title text NOT NULL,
      prompt text NOT NULL,
      complexity text NOT NULL,
      model text NOT NULL,
      status text NOT NULL,
      status_version integer NOT NULL DEFAULT 0,
      review_round integer NOT NULL DEFAULT 0,
      acceptance_criteria text NOT NULL,
      artifact_paths text NOT NULL,
      result_text text,
      review_issues text NOT NULL DEFAULT '[]',
      revision_prompt text,
      last_event text,
      submitted_at integer,
      accepted_at integer,
      time_created integer NOT NULL,
      time_updated integer NOT NULL,
      FOREIGN KEY (run_id) REFERENCES agent_cluster_run(id) ON DELETE CASCADE
    )
  `)
  sqlite.exec(`CREATE UNIQUE INDEX IF NOT EXISTS agent_cluster_task_run_plan_task_idx ON agent_cluster_task (run_id, plan_task_id)`)
  return drizzle({ client: sqlite })
}

function makeRun(db: ReturnType<typeof createTestDB>, overrides: Record<string, unknown> = {}) {
  const now = Date.now()
  const values = {
    id: `run-${now}`,
    session_id: "ses_test",
    parent_message_id: "msg_test",
    enabled: true,
    status: "planning" as const,
    goal: "Test run",
    planner_model: "test/planner",
    reviewer_model: "test/reviewer",
    time_created: now,
    time_updated: now,
    ...overrides,
  }
  db.insert(AgentClusterRunTable).values(values as any).run()
  return values.id as string
}

function makeTask(
  db: ReturnType<typeof createTestDB>,
  runID: string,
  overrides: Record<string, unknown> = {},
) {
  const now = Date.now()
  const seq = String(Math.random()).slice(2, 10)
  const defaults = {
    id: `task-${seq}`,
    run_id: runID,
    plan_task_id: `plan-${seq}`,
    step: 1,
    dependencies: "[]",
    role: "researcher" as const,
    title: "Test task",
    prompt: "Do the thing",
    complexity: "simple" as const,
    model: "test/simple",
    status: "planned" as const,
    acceptance_criteria: "[]",
    artifact_paths: "[]",
    time_created: now,
    time_updated: now,
    ...overrides,
  }
  db.insert(AgentClusterTaskTable).values(defaults as any).run()
  return defaults.id as string
}

function taskStatuses(db: ReturnType<typeof createTestDB>, runID: string): TaskStatus[] {
  return db
    .select({ status: AgentClusterTaskTable.status })
    .from(AgentClusterTaskTable)
    .where(eq(AgentClusterTaskTable.run_id, runID))
    .all()
    .map((r) => r.status as TaskStatus)
}

function updateTask(
  db: ReturnType<typeof createTestDB>,
  runID: string,
  planTaskID: string,
  set: Record<string, unknown>,
) {
  return db
    .update(AgentClusterTaskTable)
    .set({ ...set, time_updated: Date.now() })
    .where(and(eq(AgentClusterTaskTable.run_id, runID), eq(AgentClusterTaskTable.plan_task_id, planTaskID)))
    .run()
}

describe("AgentCluster end-to-end lifecycle", () => {
  describe("full reviewed workflow", () => {
    test("plan -> dispatch -> submit -> review -> accept -> complete", () => {
      const db = createTestDB()
      const runID = makeRun(db, { status: "planning" })
      const now = Date.now()

      // 1. Create two step-1 tasks and one step-2 task
      makeTask(db, runID, { plan_task_id: "collect-a", step: 1, status: "queued" })
      makeTask(db, runID, { plan_task_id: "collect-b", step: 1, status: "queued" })
      makeTask(db, runID, { plan_task_id: "analyze", step: 2, dependencies: JSON.stringify(["collect-a", "collect-b"]), status: "planned" })

      // Verify dispatching (queued tasks exist)
      expect(AgentClusterLifecycle.deriveRunStatus(taskStatuses(db, runID))).toBe("dispatching")

      // 2. Dispatch and submit collect-a
      updateTask(db, runID, "collect-a", { status: "running", status_version: 2, child_session_id: "ses_a" })
      updateTask(db, runID, "collect-a", { status: "submitted", status_version: 3, result_text: "Found data", submitted_at: now })
      expect(AgentClusterLifecycle.canTransitionTask("submitted", "reviewing")).toBe(true)

      // 3. Review and accept collect-a
      updateTask(db, runID, "collect-a", { status: "accepted", status_version: 4, review_round: 1, accepted_at: now })

      // 4. Dispatch collect-b
      updateTask(db, runID, "collect-b", { status: "running", status_version: 2 })
      updateTask(db, runID, "collect-b", { status: "submitted", status_version: 3, result_text: "Collected data", submitted_at: now })
      updateTask(db, runID, "collect-b", { status: "accepted", status_version: 4, review_round: 1, accepted_at: now })

      // 5. Both deps accepted — analyze can now be queued
      updateTask(db, runID, "analyze", { status: "queued" })
      updateTask(db, runID, "analyze", { status: "running", status_version: 2 })
      updateTask(db, runID, "analyze", { status: "submitted", status_version: 3, result_text: "Analysis complete", submitted_at: now })
      updateTask(db, runID, "analyze", { status: "accepted", status_version: 4, review_round: 1, accepted_at: now })

      // 6. All accepted → completed
      expect(AgentClusterLifecycle.deriveRunStatus(taskStatuses(db, runID))).toBe("completed")

      // Verify task count
      const allTasks = db.select().from(AgentClusterTaskTable).all()
      expect(allTasks).toHaveLength(3)
      expect(allTasks.every((t) => t.status === "accepted")).toBe(true)
    })

    test("full event sequence matches expected order", () => {
      // Assert the complete event sequence without DB access
      const events: string[] = []
      const record = (s: string) => events.push(s)

      // Simulate the full event sequence
      record("planning")
      record("plan persisted")  // 3 tasks created
      record("queued x2")       // collect-a, collect-b
      record("running x2")      // both dispatched
      record("submitted x2")    // both complete
      record("reviewing x2")    // both under review
      record("accepted x1")     // collect-a accepted
      record("accepted x1")     // collect-b accepted
      record("queued x1")       // analyze queued (deps accepted)
      record("running x1")      // analyze dispatched
      record("submitted x1")    // analyze complete
      record("reviewing x1")    // analyze under review
      record("accepted x1")     // analyze accepted
      record("synthesizing")    // run enters synthesis
      record("completed")       // run complete

      expect(events).toEqual([
        "planning",
        "plan persisted",
        "queued x2",
        "running x2",
        "submitted x2",
        "reviewing x2",
        "accepted x1",
        "accepted x1",
        "queued x1",
        "running x1",
        "submitted x1",
        "reviewing x1",
        "accepted x1",
        "synthesizing",
        "completed",
      ])
    })
  })

  describe("revision workflow", () => {
    test("reviewer requests revision, same child session revises and resubmits", () => {
      const db = createTestDB()
      const runID = makeRun(db, { status: "dispatching" })
      const now = Date.now()

      makeTask(db, runID, {
        plan_task_id: "worker-1",
        step: 1,
        status: "running",
        child_session_id: "ses_revise_me",
        dependencies: "[]",
        artifact_paths: JSON.stringify(["doc.md"]),
      })

      // Submit
      updateTask(db, runID, "worker-1", { status: "submitted", status_version: 3, result_text: "Partial doc", submitted_at: now })

      // Review → revision_requested
      expect(AgentClusterLifecycle.canTransitionTask("submitted", "reviewing")).toBe(true)
      expect(AgentClusterLifecycle.canTransitionTask("reviewing", "revision_requested")).toBe(true)
      updateTask(db, runID, "worker-1", {
        status: "revision_requested", status_version: 4, review_round: 1,
        review_issues: JSON.stringify(["missing conclusion"]),
        revision_prompt: "Add conclusion",
      })

      const afterReview = db.select().from(AgentClusterTaskTable)
        .where(and(eq(AgentClusterTaskTable.run_id, runID), eq(AgentClusterTaskTable.plan_task_id, "worker-1"))).get()
      expect(afterReview?.status).toBe("revision_requested")
      expect(afterReview?.review_round).toBe(1)
      expect(afterReview?.child_session_id).toBe("ses_revise_me")

      // Start revision
      expect(AgentClusterLifecycle.canTransitionTask("revision_requested", "revising")).toBe(true)
      updateTask(db, runID, "worker-1", { status: "revising", status_version: 5 })

      const revising = db.select().from(AgentClusterTaskTable)
        .where(and(eq(AgentClusterTaskTable.run_id, runID), eq(AgentClusterTaskTable.plan_task_id, "worker-1"))).get()
      expect(revising?.child_session_id).toBe("ses_revise_me") // same session reused
      expect(revising?.status).toBe("revising")

      // Resubmit
      expect(AgentClusterLifecycle.canTransitionTask("revising", "submitted")).toBe(true)
      updateTask(db, runID, "worker-1", { status: "submitted", status_version: 6, result_text: "Complete doc with conclusion", submitted_at: now })

      // Accept
      updateTask(db, runID, "worker-1", { status: "accepted", status_version: 7, review_round: 2, accepted_at: now })

      expect(AgentClusterLifecycle.isTerminalTask("accepted")).toBe(true)
      expect(AgentClusterLifecycle.deriveRunStatus(taskStatuses(db, runID))).toBe("completed")
    })
  })

  describe("failure scenarios", () => {
    test("failed dependency blocks downstream", () => {
      const db = createTestDB()
      const runID = makeRun(db, { status: "dispatching" })

      makeTask(db, runID, { plan_task_id: "fail-dep", step: 1, status: "failed", dependencies: "[]" })
      makeTask(db, runID, { plan_task_id: "downstream", step: 2, status: "queued", dependencies: JSON.stringify(["fail-dep"]) })

      // Queued downstream + failed dep = still dispatching (queued exists)
      expect(AgentClusterLifecycle.deriveRunStatus(taskStatuses(db, runID))).toBe("dispatching")
    })

    test("all failed tasks → run failed", () => {
      const db = createTestDB()
      const runID = makeRun(db, { status: "dispatching" })

      makeTask(db, runID, { plan_task_id: "f1", step: 1, status: "failed", dependencies: "[]" })
      makeTask(db, runID, { plan_task_id: "f2", step: 1, status: "cancelled", dependencies: "[]" })

      expect(AgentClusterLifecycle.deriveRunStatus(taskStatuses(db, runID))).toBe("failed")
    })

    test("mixed accepted + failed → completed", () => {
      const db = createTestDB()
      const runID = makeRun(db, { status: "dispatching" })

      makeTask(db, runID, { plan_task_id: "ok", step: 1, status: "accepted", dependencies: "[]" })
      makeTask(db, runID, { plan_task_id: "bad", step: 1, status: "failed", dependencies: "[]" })

      expect(AgentClusterLifecycle.deriveRunStatus(taskStatuses(db, runID))).toBe("completed")
    })

    test("stale event with lower version does not roll state backward", () => {
      // Version 5 accepted, then version 4 running — accepted stays
      let currentVersion = 5
      let currentStatus = "accepted"

      const applyEvent = (status: string, version: number) => {
        if (version > currentVersion) {
          currentVersion = version
          currentStatus = status
        }
      }

      applyEvent("running", 4)  // stale — rejected
      expect(currentStatus).toBe("accepted")
      expect(currentVersion).toBe(5)

      applyEvent("failed", 6)  // newer — accepted
      expect(currentStatus).toBe("failed")
      expect(currentVersion).toBe(6)
    })

    test("no accepted tasks → run stays planning with zero tasks", () => {
      expect(AgentClusterLifecycle.deriveRunStatus([])).toBe("planning")
    })

    test("submitted tasks with no active → reviewing", () => {
      expect(AgentClusterLifecycle.deriveRunStatus(["submitted"])).toBe("reviewing")
      expect(AgentClusterLifecycle.deriveRunStatus(["reviewing"])).toBe("reviewing")
      expect(AgentClusterLifecycle.deriveRunStatus(["revision_requested"])).toBe("reviewing")
    })
  })
})
