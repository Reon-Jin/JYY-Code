import { describe, expect } from "bun:test"
import { Effect, Layer } from "effect"
import { Session } from "../../src/session/session"
import * as Database from "../../src/storage/db"
import { WorkflowLedger } from "../../src/workflow/ledger"
import { testEffect } from "../lib/effect"

const it = testEffect(Layer.mergeAll(Session.defaultLayer, Database.layer))

describe("Workflow context ledger", () => {
  it.instance("preserves user constraints, retrieves context, and stores artifacts", () =>
    Effect.gen(function* () {
      const session = yield* (yield* Session.Service).create({ title: "Ledger" })
      const constraint = yield* WorkflowLedger.addContext({
        sessionID: session.id,
        source: "user_constraint",
        priority: "critical",
        provenance: "user message",
        retention: "session",
        cachePolicy: "stable",
        scope: {},
        content: "Keep the interface neutral and concise.",
      })
      yield* WorkflowLedger.addContext({
        sessionID: session.id,
        source: "tool_result",
        priority: "low",
        provenance: "test",
        retention: "turn",
        cachePolicy: "volatile",
        scope: {},
        content: "A deliberately long low-priority result that should not fit a tiny budget.",
      })
      const context = yield* WorkflowLedger.buildContext({ sessionID: session.id, budget: 1 })
      expect(context.blocks.map((block) => block.id)).toContain(constraint.id)
      expect(yield* WorkflowLedger.getContext(constraint.id)).toMatchObject({ content: constraint.content })

      const artifact = yield* WorkflowLedger.putArtifact({
        sessionID: session.id,
        name: "result.md",
        mediaType: "text/markdown",
        content: "# Result",
        summary: "A validated result",
        metadata: { source: "test" },
      })
      expect((yield* WorkflowLedger.getArtifact(artifact.uri)).content).toBe("# Result")
      expect((yield* WorkflowLedger.listArtifacts(session.id)).map((item) => item.uri)).toContain(artifact.uri)

      const call = yield* WorkflowLedger.recordModelCall({
        sessionID: session.id,
        role: "main_agent",
        model: "test/model",
        contextBlockIDs: [constraint.id],
        inputTokens: 42,
        outputTokens: 9,
        status: "completed",
        completedAt: Date.now(),
      })
      expect(call.contextBlockIDs).toEqual([constraint.id])
    }),
  )
})
