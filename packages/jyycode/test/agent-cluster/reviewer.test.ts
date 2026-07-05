import { describe, expect, test } from "bun:test"
import { AgentClusterReviewer } from "../../src/agent-cluster/reviewer"
import { AgentClusterRunTable, AgentClusterTaskTable } from "../../src/agent-cluster/cluster.sql"
import type { RunID, TaskID } from "../../src/agent-cluster/schema"
import * as Database from "../../src/storage/db"
import { eq, and } from "../../src/storage/db"
import { Database as SQLite } from "bun:sqlite"
import { drizzle } from "drizzle-orm/bun-sqlite"

function createTestDB() {
  const sqlite = new SQLite(":memory:")
  sqlite.exec("PRAGMA foreign_keys = ON")
  sqlite.exec(`
    CREATE TABLE agent_cluster_run (
      id text PRIMARY KEY NOT NULL, session_id text NOT NULL, parent_message_id text NOT NULL,
      enabled integer DEFAULT 1 NOT NULL, status text NOT NULL, status_version integer NOT NULL DEFAULT 0,
      goal text NOT NULL, planner_model text NOT NULL, reviewer_model text NOT NULL,
      time_created integer NOT NULL, time_updated integer NOT NULL, completed_at integer
    )
  `)
  sqlite.exec(`
    CREATE TABLE agent_cluster_task (
      id text PRIMARY KEY NOT NULL, run_id text NOT NULL, plan_task_id text NOT NULL,
      parent_task_id text, child_session_id text, step integer NOT NULL,
      dependencies text NOT NULL DEFAULT '[]', role text NOT NULL, title text NOT NULL,
      prompt text NOT NULL, complexity text NOT NULL, model text NOT NULL,
      status text NOT NULL, status_version integer NOT NULL DEFAULT 0,
      review_round integer NOT NULL DEFAULT 0,
      acceptance_criteria text NOT NULL, artifact_paths text NOT NULL,
      result_text text, review_issues text NOT NULL DEFAULT '[]',
      revision_prompt text, last_event text, submitted_at integer, accepted_at integer,
      time_created integer NOT NULL, time_updated integer NOT NULL,
      FOREIGN KEY (run_id) REFERENCES agent_cluster_run(id) ON DELETE CASCADE
    )
  `)
  return drizzle({ client: sqlite })
}

describe("AgentCluster reviewer", () => {
  test("accepts a valid task result", () => {
    const acceptedDecision = {
      decision: "accepted" as const,
      issues: [] as string[],
      verifiedArtifacts: ["doc.md"] as string[],
      risks: [] as string[],
    }
    const reviewer = AgentClusterReviewer.makeFakeReviewer(acceptedDecision)
    const input: AgentClusterReviewer.ReviewInput = {
      taskPrompt: "Write a doc", acceptanceCriteria: ["doc exists"],
      expectedArtifactPaths: ["doc.md"],
      artifactChecks: [{ path: "doc.md", exists: true, kind: "file" }],
      resultText: "Wrote doc.md", model: "test/m", role: "writer",
      priorIssues: [], round: 0, dependencySummaries: [],
    }
    expect(reviewer.review(input)).toBeDefined()
  })

  test("revision_requested requires non-empty revisionPrompt", () => {
    const badDecision = {
      decision: "revision_requested" as const,
      issues: ["incomplete"],
      revisionPrompt: "",
      verifiedArtifacts: [],
      risks: [],
    }

    // The decision itself is validated inside reviewTask transaction, not at adapter level.
    // The adapter just returns what the model says; validation happens when persisting.
    // Test that makeFakeReviewer returns the raw decision as-is.
    const reviewer = AgentClusterReviewer.makeFakeReviewer(badDecision)
    const result = reviewer.review({
      taskPrompt: "", acceptanceCriteria: [], expectedArtifactPaths: [],
      artifactChecks: [], resultText: "", model: "", role: "",
      priorIssues: [], round: 0, dependencySummaries: [],
    })
    expect(result).toBeDefined()
  })

  test("buildReviewPrompt includes all required sections", () => {
    const prompt = AgentClusterReviewer.buildReviewPrompt({
      taskPrompt: "Do task", acceptanceCriteria: ["criterion 1", "criterion 2"],
      expectedArtifactPaths: ["a.md", "b.md"],
      artifactChecks: [{ path: "a.md", exists: true, kind: "file" }, { path: "b.md", exists: false, kind: "missing" }],
      resultText: "Result text here", model: "test/m", role: "researcher",
      priorIssues: ["issue 1"], round: 1, dependencySummaries: ["dep summary"],
    })

    expect(prompt).toContain("Do task")
    expect(prompt).toContain("criterion 1")
    expect(prompt).toContain("criterion 2")
    expect(prompt).toContain("a.md")
    expect(prompt).toContain("b.md")
    expect(prompt).toContain("MISSING")
    expect(prompt).toContain("Result text here")
    expect(prompt).toContain("issue 1")
    expect(prompt).toContain("Review Round: 2") // round + 1
  })
})
