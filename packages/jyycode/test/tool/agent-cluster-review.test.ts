import { afterEach, describe, expect } from "bun:test"
import path from "path"
import { Effect, Exit, Layer } from "effect"
import { Agent } from "@/agent/agent"
import { AgentClusterReviewTool } from "@/tool/agent-cluster-review"
import { AppFileSystem } from "@jyycode-ai/core/filesystem"
import { Config } from "@/config/config"
import { Session } from "@/session/session"
import { MessageID, PartID } from "@/session/schema"
import { ModelID, ProviderID } from "@/provider/schema"
import { Truncate } from "@/tool/truncate"
import * as Database from "@/storage/db"
import { WorkflowCollaboration } from "@/workflow/collaboration"
import { WorkflowExecutor } from "@/workflow/executor"
import { WorkflowRuntime } from "@/workflow/runtime"
import { TestConfig } from "../fixture/config"
import { disposeAllInstances } from "../fixture/fixture"
import { testEffect } from "../lib/effect"
import { ulid } from "ulid"

afterEach(async () => {
  await disposeAllInstances()
})

const ref = { providerID: ProviderID.make("test"), modelID: ModelID.make("test-model") }

const layer = (maxReviewRounds = 3) =>
  Layer.mergeAll(
    Agent.defaultLayer,
    AppFileSystem.defaultLayer,
    Session.defaultLayer,
    Truncate.defaultLayer,
    Database.layer,
    TestConfig.layer({ get: () => Effect.succeed({ agent_cluster: { max_review_rounds: maxReviewRounds } }) }),
  ).pipe(Layer.provide(Config.defaultLayer))

const it = testEffect(layer())
const maxTwo = testEffect(layer(2))

const seed = Effect.fn("WorkflowReviewTest.seed")(function* (input?: {
  status?: "planned" | "submitted" | "reviewing"
  artifactPaths?: string[]
  reviewRound?: number
}) {
  const sessions = yield* Session.Service
  const chat = yield* sessions.create({ title: "Workflow review" })
  const child = yield* sessions.create({ parentID: chat.id, title: "Review child" })
  const taskID = `api-${ulid()}`
  const user = yield* sessions.updateMessage({ id: MessageID.ascending(), role: "user", sessionID: chat.id, agent: "cluster", model: ref, time: { created: Date.now() } })
  const assistant = yield* sessions.updateMessage({
    id: MessageID.ascending(), role: "assistant", parentID: user.id, sessionID: chat.id, mode: "cluster", agent: "cluster", cost: 0,
    path: { cwd: chat.directory, root: chat.directory }, tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    modelID: ref.modelID, providerID: ref.providerID, time: { created: Date.now() },
  })
  yield* sessions.updatePart({ id: PartID.ascending(), messageID: assistant.id, sessionID: chat.id, type: "text", synthetic: true, metadata: { kind: "agent_cluster", sessionID: chat.id }, text: "workflow" })
  const plan = yield* WorkflowExecutor.applyMultiAgentPlan({
    sessionID: chat.id,
    plan: { goal: "Review task", tasks: [{ id: taskID, step: 1, title: "API", role: "coder", prompt: "Build API", complexity: "simple", model: "test/simple", dependencies: [], acceptanceCriteria: ["tests pass", "artifact exists"], expectedArtifacts: input?.artifactPaths ?? [] }] },
  })
  if ((input?.status ?? "submitted") !== "planned") {
    const prepared = yield* WorkflowExecutor.prepareMultiTask({ sessionID: chat.id, taskID })
    yield* WorkflowExecutor.startMultiTask({ sessionID: chat.id, runPlanID: prepared.plan.id, taskID: prepared.task.id, childSessionID: child.id })
    yield* WorkflowExecutor.submitMultiTask({ sessionID: chat.id, runPlanID: prepared.plan.id, taskID: prepared.task.id, childSessionID: child.id, summary: "Submitted for review." })
    if (input?.status === "reviewing") {
      yield* WorkflowRuntime.transitionNode({ sessionID: chat.id, runPlanID: plan.id, nodeID: prepared.task.id, from: "submitted", to: "reviewing" })
    }
  }
  for (let index = 0; index < (input?.reviewRound ?? 0); index++) {
    yield* WorkflowCollaboration.createReviewFinding({ sessionID: chat.id, runPlanID: plan.id, nodeID: taskID as any, authorAgentID: "reviewer", severity: "medium", summary: "Earlier revision", evidence: [], suggestion: "Revise." })
  }
  return { chat, assistant, taskID, childSessionID: child.id }
})

function ctx(input: { chat: Session.Info; assistant: any }) {
  return { sessionID: input.chat.id, messageID: input.assistant.id, agent: "cluster", abort: new AbortController().signal, extra: { agentClusterSessionID: input.chat.id }, messages: [], metadata: () => Effect.void, ask: () => Effect.void }
}

const taskStatus = Effect.fn("WorkflowReviewTest.taskStatus")(function* (sessionID: any, taskID: string) {
  return (yield* WorkflowRuntime.getSessionRunPlan(sessionID)).tasks.find((task) => task.id === taskID as any)?.status
})

describe("agent_cluster_review", () => {
  it.instance("rejects reviews for tasks outside submitted or reviewing", () => Effect.gen(function* () {
    const seeded = yield* seed({ status: "planned" })
    const def = yield* (yield* AgentClusterReviewTool).init()
    const exit = yield* def.execute({ task_id: seeded.taskID, decision: "failed", checks: [], issues: ["not ready"] }, ctx(seeded)).pipe(Effect.exit)
    expect(Exit.isFailure(exit)).toBe(true)
  }))

  it.instance("requires passing evidence for every acceptance criterion before accepting", () => Effect.gen(function* () {
    const seeded = yield* seed()
    const def = yield* (yield* AgentClusterReviewTool).init()
    const exit = yield* def.execute({ task_id: seeded.taskID, decision: "accepted", checks: [{ criterion: "tests pass", passed: true, evidence: "bun test: pass" }], issues: [] }, ctx(seeded)).pipe(Effect.exit)
    expect(Exit.isFailure(exit)).toBe(true)
  }))

  it.instance("leaves submitted work untouched when acceptance validation fails", () => Effect.gen(function* () {
    const seeded = yield* seed({ artifactPaths: ["missing.txt"] })
    const def = yield* (yield* AgentClusterReviewTool).init()
    const exit = yield* def.execute({ task_id: seeded.taskID, decision: "accepted", checks: [{ criterion: "tests pass", passed: true, evidence: "bun test: pass" }, { criterion: "artifact exists", passed: true, evidence: "reported missing.txt" }], issues: [] }, ctx(seeded)).pipe(Effect.exit)
    expect(Exit.isFailure(exit)).toBe(true)
    expect(yield* taskStatus(seeded.chat.id, seeded.taskID)).toBe("submitted")
  }))

  it.instance("accepts submitted work with complete evidence and existing artifacts", () => Effect.gen(function* () {
    const seeded = yield* seed({ artifactPaths: ["artifact.txt"] })
    yield* Effect.promise(() => Bun.write(path.join(seeded.chat.directory, "artifact.txt"), "ok"))
    const def = yield* (yield* AgentClusterReviewTool).init()
    const result = yield* def.execute({ task_id: seeded.childSessionID, decision: "accepted", checks: [{ criterion: "tests pass", passed: true, evidence: "bun test: pass" }, { criterion: "artifact exists", passed: true, evidence: "artifact.txt exists" }], issues: [] }, ctx(seeded))
    expect(result.output).toContain("decision: accepted")
    expect(yield* taskStatus(seeded.chat.id, seeded.taskID)).toBe("accepted")
  }))

  maxTwo.instance("fails instead of requesting another revision after the max round", () => Effect.gen(function* () {
    const seeded = yield* seed({ reviewRound: 1 })
    const def = yield* (yield* AgentClusterReviewTool).init()
    const result = yield* def.execute({ task_id: seeded.taskID, decision: "revision_requested", checks: [], issues: ["missing tests"], revision_prompt: "Run tests and report results." }, ctx(seeded))
    expect(result.output).toContain("maximum review rounds reached")
    expect(yield* taskStatus(seeded.chat.id, seeded.taskID)).toBe("failed")
  }))
})
