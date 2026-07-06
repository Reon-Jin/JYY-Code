import { afterEach, describe, expect } from "bun:test"
import path from "path"
import { Effect, Exit, Layer } from "effect"
import { Agent } from "@/agent/agent"
import { AgentClusterRunTable, AgentClusterTaskTable } from "@/agent-cluster/cluster.sql"
import { AgentCluster } from "@/agent-cluster/cluster"
import { AgentClusterReviewTool } from "@/tool/agent-cluster-review"
import { AppFileSystem } from "@jyycode-ai/core/filesystem"
import { Config } from "@/config/config"
import { Session } from "@/session/session"
import { MessageID, PartID } from "@/session/schema"
import { ModelID, ProviderID } from "@/provider/schema"
import { Truncate } from "@/tool/truncate"
import * as Database from "@/storage/db"
import { TestConfig } from "../fixture/config"
import { disposeAllInstances } from "../fixture/fixture"
import { testEffect } from "../lib/effect"
import { ulid } from "ulid"

afterEach(async () => {
  await disposeAllInstances()
})

const ref = {
  providerID: ProviderID.make("test"),
  modelID: ModelID.make("test-model"),
}

const layer = (maxReviewRounds = 3) =>
  Layer.mergeAll(
    Agent.defaultLayer,
    AppFileSystem.defaultLayer,
    Session.defaultLayer,
    Truncate.defaultLayer,
    TestConfig.layer({
      get: () => Effect.succeed({ agent_cluster: { max_review_rounds: maxReviewRounds } }),
    }),
  ).pipe(Layer.provide(Config.defaultLayer))

const it = testEffect(layer())
const maxTwo = testEffect(layer(2))

const seed = Effect.fn("AgentClusterReviewTest.seed")(function* (input?: {
  status?: "planned" | "submitted" | "reviewing"
  artifactPaths?: string[]
  reviewRound?: number
}) {
  const sessions = yield* Session.Service
  const chat = yield* sessions.create({ title: "Cluster review" })
  const runID = AgentCluster.createRunID()
  const taskID = `api-${ulid()}`
  const childSessionID = `ses_${ulid()}`
  const user = yield* sessions.updateMessage({
    id: MessageID.ascending(),
    role: "user",
    sessionID: chat.id,
    agent: "cluster",
    model: ref,
    time: { created: Date.now() },
  })
  const assistant = yield* sessions.updateMessage({
    id: MessageID.ascending(),
    role: "assistant",
    parentID: user.id,
    sessionID: chat.id,
    mode: "cluster",
    agent: "cluster",
    cost: 0,
    path: { cwd: chat.directory, root: chat.directory },
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    modelID: ref.modelID,
    providerID: ref.providerID,
    time: { created: Date.now() },
  })
  yield* sessions.updatePart({
    id: PartID.ascending(),
    messageID: assistant.id,
    sessionID: chat.id,
    type: "text",
    synthetic: true,
    metadata: { kind: "agent_cluster", runID },
    text: "cluster",
  })
  const now = Date.now()
  Database.use((db) => {
    db.insert(AgentClusterRunTable)
      .values({
        id: runID as any,
        session_id: chat.id,
        parent_message_id: user.id,
        enabled: true,
        status: "reviewing",
        goal: "Ship feature",
        planner_model: "test/planner",
        reviewer_model: "test/reviewer",
        time_created: now,
        time_updated: now,
      })
      .run()
    db.insert(AgentClusterTaskTable)
      .values({
        id: taskID as any,
        run_id: runID as any,
        child_session_id: childSessionID as any,
        role: "coder",
        title: "API",
        prompt: "Build API",
        complexity: "simple",
        model: "test/simple",
        status: input?.status ?? "submitted",
        review_round: input?.reviewRound ?? 0,
        acceptance_criteria: ["tests pass", "artifact exists"],
        artifact_paths: input?.artifactPaths ?? [],
        time_created: now,
        time_updated: now,
      })
      .run()
  })
  return { chat, assistant, runID, taskID, childSessionID }
})

function ctx(input: { chat: Session.Info; assistant: any; runID: string }) {
  return {
    sessionID: input.chat.id,
    messageID: input.assistant.id,
    agent: "cluster",
    abort: new AbortController().signal,
    extra: { agentClusterRunID: input.runID },
    messages: [],
    metadata: () => Effect.void,
    ask: () => Effect.void,
  }
}

describe("agent_cluster_review", () => {
  it.instance("rejects reviews for tasks outside submitted or reviewing", () =>
    Effect.gen(function* () {
      const seeded = yield* seed({ status: "planned" })
      const def = yield* (yield* AgentClusterReviewTool).init()

      const exit = yield* def
        .execute(
          { task_id: seeded.taskID, decision: "failed", checks: [], issues: ["not ready"] },
          ctx(seeded),
        )
        .pipe(Effect.exit)

      expect(Exit.isFailure(exit)).toBe(true)
    }),
  )

  it.instance("requires passing evidence for every acceptance criterion before accepting", () =>
    Effect.gen(function* () {
      const seeded = yield* seed()
      const def = yield* (yield* AgentClusterReviewTool).init()

      const exit = yield* def
        .execute(
          {
            task_id: seeded.taskID,
            decision: "accepted",
            checks: [{ criterion: "tests pass", passed: true, evidence: "bun test: pass" }],
            issues: [],
          },
          ctx(seeded),
        )
        .pipe(Effect.exit)

      expect(Exit.isFailure(exit)).toBe(true)
    }),
  )

  it.instance("rejects accepted decisions when a declared artifact is missing", () =>
    Effect.gen(function* () {
      const seeded = yield* seed({ artifactPaths: ["missing.txt"] })
      const def = yield* (yield* AgentClusterReviewTool).init()

      const exit = yield* def
        .execute(
          {
            task_id: seeded.taskID,
            decision: "accepted",
            checks: [
              { criterion: "tests pass", passed: true, evidence: "bun test: pass" },
              { criterion: "artifact exists", passed: true, evidence: "reported missing.txt" },
            ],
            issues: [],
          },
          ctx(seeded),
        )
        .pipe(Effect.exit)

      expect(Exit.isFailure(exit)).toBe(true)
    }),
  )

  it.instance("accepts submitted work with complete evidence and existing artifacts", () =>
    Effect.gen(function* () {
      const seeded = yield* seed({ artifactPaths: ["artifact.txt"] })
      yield* Effect.promise(() => Bun.write(path.join(seeded.chat.directory, "artifact.txt"), "ok"))
      const def = yield* (yield* AgentClusterReviewTool).init()

      const result = yield* def.execute(
        {
          task_id: seeded.childSessionID,
          decision: "accepted",
          checks: [
            { criterion: "tests pass", passed: true, evidence: "bun test: pass" },
            { criterion: "artifact exists", passed: true, evidence: "artifact.txt exists" },
          ],
          issues: [],
        },
        ctx(seeded),
      )
      const row = Database.use((db) =>
        db
          .select()
          .from(AgentClusterTaskTable)
          .where(Database.eq(AgentClusterTaskTable.id, seeded.taskID as any))
          .get(),
      )

      expect(result.output).toContain("decision: accepted")
      expect(row?.status).toBe("accepted")
      expect(row?.review_issues).toEqual([])
    }),
  )

  maxTwo.instance("fails instead of requesting another revision after the max round", () =>
    Effect.gen(function* () {
      const seeded = yield* seed({ reviewRound: 1 })
      const def = yield* (yield* AgentClusterReviewTool).init()

      const result = yield* def.execute(
        {
          task_id: seeded.taskID,
          decision: "revision_requested",
          checks: [],
          issues: ["missing tests"],
          revision_prompt: "Run tests and report results.",
        },
        ctx(seeded),
      )
      const task = Database.use((db) =>
        db
          .select()
          .from(AgentClusterTaskTable)
          .where(Database.eq(AgentClusterTaskTable.id, seeded.taskID as any))
          .get(),
      )
      const run = Database.use((db) =>
        db
          .select()
          .from(AgentClusterRunTable)
          .where(Database.eq(AgentClusterRunTable.id, seeded.runID as any))
          .get(),
      )

      expect(result.output).toContain("maximum review rounds reached")
      expect(task?.status).toBe("failed")
      expect(task?.review_round).toBe(2)
      expect(run?.status).toBe("failed")
    }),
  )
})
