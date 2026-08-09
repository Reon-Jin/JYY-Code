import { describe, expect, test } from "bun:test"
import { Deadline } from "../../src/execution/deadline"
import {
  assessProgress,
  createCheckpoint,
  decodeCheckpoint,
  measureEffectiveContext,
  sourceHighWatermark,
  validateCheckpoint,
} from "../../src/session/compaction-checkpoint"
import { planRecovery, recoverPaged } from "../../src/session/compaction-recovery"
import { SessionID, MessageID } from "../../src/session/schema"

const sessionID = SessionID.make("ses_checkpoint")

function user(id: string, created: number, text: string) {
  return {
    info: { id: MessageID.make(id), role: "user", time: { created } },
    parts: [{ type: "text", text }],
  }
}

describe("compaction checkpoints", () => {
  test("round-trips structured recovery facts and validates the source watermark", () => {
    const messages = [user("msg_1", 10, "goal")]
    const source = sourceHighWatermark(messages)
    const checkpoint = createCheckpoint({
      sessionID,
      sourceHighWatermark: source,
      before: measureEffectiveContext(messages),
      goal: "ship the fix",
      constraints: ["keep the API stable"],
      decisions: ["use a copy-only recovery"],
      progress: ["added tests"],
      files: ["src/session/prompt.ts"],
      commands: ["bun test"],
      tests: ["compaction-recovery"],
      pending: ["run soak"],
      blocked: [],
      verbatimTailMessageIDs: [MessageID.make("msg_1")],
    })

    expect(validateCheckpoint(decodeCheckpoint(JSON.parse(JSON.stringify(checkpoint))), { sessionID, sourceHighWatermark: source })).toBe(true)
    expect(validateCheckpoint(checkpoint, { sessionID, sourceHighWatermark: sourceHighWatermark([user("msg_2", 20, "new")]) })).toBe(false)
  })

  test("requires monotonic reduction and rejects expansion", () => {
    const before = { tokens: 20_000, bytes: 80_000 }
    expect(assessProgress(before, { tokens: 15_000, bytes: 60_000 }).ok).toBe(true)
    expect(assessProgress(before, { tokens: 19_000, bytes: 60_000 }).reason).toBe("insufficient_reduction")
    expect(assessProgress(before, { tokens: 22_000, bytes: 90_000 }).reason).toBe("expanded")
  })
})

describe("chunked compaction recovery", () => {
  test("copies pages into bounded detached chunks without mutating the source", () => {
    const source = [user("msg_1", 1, "a"), user("msg_2", 2, "b"), user("msg_3", 3, "c")]
    const plan = planRecovery(source, { pageSize: 2, maxChunks: 2, deadline: Deadline.fromDuration(5_000) })
    expect(plan.pages).toBe(2)
    expect(plan.chunks.map((chunk) => chunk.items.length)).toEqual([2, 1])
    expect(plan.truncated).toBe(false)
    expect(plan.chunks[0]?.items).not.toBe(source.slice(0, 2))
  })

  test("reads cursor pages and reports truncation at a deadline", async () => {
    const source = [user("msg_1", 1, "a"), user("msg_2", 2, "b")]
    let calls = 0
    const plan = await recoverPaged(async (cursor) => {
      calls++
      if (!cursor) return { items: source.slice(0, 1), next: "next" }
      return { items: source.slice(1), next: undefined }
    }, { pageSize: 1, deadline: Deadline.fromDuration(5_000) })
    expect(calls).toBe(2)
    expect(plan.measure.tokens).toBeGreaterThan(0)
    expect(plan.sourceHighWatermark.id).toBe("msg_2")
  })
})
