import { expect, test } from "bun:test"
import { limitSummaryPatches, MAX_SUMMARY_PATCH_BYTES } from "@/session/summary"
import { Effect, Layer, Option, Stream } from "effect"
import path from "node:path"
import { SessionSummary } from "@/session/summary"
import { Session } from "@/session/session"
import { MessageV2 } from "@/session/message-v2"
import { MessageID, PartID } from "@/session/schema"
import { ModelID, ProviderID } from "@/provider/schema"
import { Snapshot } from "@/snapshot"
import { Storage } from "@/storage/storage"
import { Bus } from "@/bus"
import { AppFileSystem } from "@jyycode-ai/core/filesystem"
import { TestInstance } from "../fixture/fixture"
import { testEffect } from "../lib/effect"

const it = testEffect(
  Layer.mergeAll(
    SessionSummary.defaultLayer,
    Session.defaultLayer,
    Snapshot.defaultLayer,
    Storage.defaultLayer,
    Bus.layer,
    AppFileSystem.defaultLayer,
  ),
)

const round = Effect.fn("SummaryTest.round")(function* (session: Session.Info, before: string, after: string) {
  const sessions = yield* Session.Service
  const user: MessageV2.User = {
    id: MessageID.ascending(),
    sessionID: session.id,
    role: "user",
    agent: "build",
    model: { providerID: ProviderID.make("test"), modelID: ModelID.make("test") },
    time: { created: Date.now() },
  }
  yield* sessions.updateMessage(user)
  const tokens = { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } }
  const assistant: MessageV2.Assistant = {
    id: MessageID.ascending(),
    sessionID: session.id,
    role: "assistant",
    parentID: user.id,
    mode: "build",
    agent: "build",
    providerID: user.model.providerID,
    modelID: user.model.modelID,
    path: { cwd: session.directory, root: "/" },
    cost: 0,
    tokens,
    finish: "stop",
    time: { created: Date.now(), completed: Date.now() },
  }
  yield* sessions.updateMessage(assistant)
  yield* sessions.updatePart({
    id: PartID.ascending(),
    sessionID: session.id,
    messageID: assistant.id,
    type: "step-start",
    snapshot: before,
  })
  yield* sessions.updatePart({
    id: PartID.ascending(),
    sessionID: session.id,
    messageID: assistant.id,
    type: "step-finish",
    snapshot: after,
    reason: "stop",
    cost: 0,
    tokens,
  })
  return user
})

it.instance(
  "non-Git sidebar and SSE show only the latest round, including empty rounds",
  () =>
    Effect.gen(function* () {
      const { directory } = yield* TestInstance
      const fs = yield* AppFileSystem.Service
      const snapshot = yield* Snapshot.Service
      const sessions = yield* Session.Service
      const summary = yield* SessionSummary.Service
      const session = yield* sessions.create()
      const events = yield* (yield* Bus.Service).subscribe(Session.Event.Diff)
      const nextEvent = () => Stream.runHead(events).pipe(Effect.timeout("5 seconds"))
      yield* fs.writeWithDirs(path.join(directory, "document.txt"), "start\n")
      yield* fs.writeWithDirs(path.join(directory, "old.png"), new Uint8Array([0, 1, 2]))
      const start = (yield* snapshot.track())!
      yield* fs.writeWithDirs(path.join(directory, "document.txt"), "first\n")
      yield* fs.remove(path.join(directory, "old.png"))
      const firstEnd = (yield* snapshot.track())!
      const first = yield* round(session, start, firstEnd)
      yield* summary.summarize({ sessionID: session.id, messageID: first.id })
      yield* nextEvent()

      yield* fs.writeWithDirs(path.join(directory, "simple.png"), new Uint8Array([0, 3, 4]))
      const secondEnd = (yield* snapshot.track())!
      const second = yield* round(session, firstEnd, secondEnd)
      yield* summary.summarize({ sessionID: session.id, messageID: second.id })
      const secondDiff = yield* summary.diff({ sessionID: session.id })
      expect(secondDiff.map((change) => change.file)).toEqual(["simple.png"])
      expect(Option.getOrUndefined(yield* nextEvent())?.properties.diff).toEqual(secondDiff)
      expect(
        (yield* summary.diff({ sessionID: session.id, messageID: first.id })).map((change) => change.file),
      ).toEqual(["document.txt", "old.png"])

      yield* fs.writeWithDirs(path.join(directory, "document.txt"), "second\n")
      const thirdEnd = (yield* snapshot.track())!
      const third = yield* round(session, secondEnd, thirdEnd)
      yield* summary.summarize({ sessionID: session.id, messageID: third.id })
      const thirdDiff = yield* summary.diff({ sessionID: session.id })
      expect(thirdDiff).toHaveLength(1)
      expect(thirdDiff[0]?.patch).toContain("-first")
      expect(thirdDiff[0]?.patch).toContain("+second")
      expect(thirdDiff[0]?.patch).not.toContain("-start")
      yield* nextEvent()

      const fourth = yield* round(session, thirdEnd, thirdEnd)
      // Before summary persistence, snapshots already delimit this new empty round.
      expect(yield* summary.diff({ sessionID: session.id })).toEqual([])
      yield* summary.summarize({ sessionID: session.id, messageID: fourth.id })
      expect(yield* summary.diff({ sessionID: session.id })).toEqual([])
      expect(Option.getOrUndefined(yield* nextEvent())?.properties.diff).toEqual([])
      expect(
        (yield* summary.diff({ sessionID: session.id, messageID: second.id })).map((change) => change.file),
      ).toEqual(["simple.png"])
      // An older delayed summarizer must not overwrite the sidebar with an old turn.
      yield* summary.summarize({ sessionID: session.id, messageID: first.id })
      expect(Option.getOrUndefined(yield* nextEvent())?.properties.diff).toEqual([])
    }),
  30_000,
)

it.instance(
  "Git default diffs retain the aggregate while explicit turns stay isolated",
  () =>
    Effect.gen(function* () {
      const { directory } = yield* TestInstance
      const fs = yield* AppFileSystem.Service
      const snapshot = yield* Snapshot.Service
      const session = yield* (yield* Session.Service).create()
      const summary = yield* SessionSummary.Service
      const start = (yield* snapshot.track())!
      yield* fs.writeWithDirs(path.join(directory, "first.txt"), "first\n")
      const firstEnd = (yield* snapshot.track())!
      const first = yield* round(session, start, firstEnd)
      yield* summary.summarize({ sessionID: session.id, messageID: first.id })
      yield* fs.writeWithDirs(path.join(directory, "second.txt"), "second\n")
      const secondEnd = (yield* snapshot.track())!
      const second = yield* round(session, firstEnd, secondEnd)
      yield* summary.summarize({ sessionID: session.id, messageID: second.id })
      expect((yield* summary.diff({ sessionID: session.id })).map((change) => change.file)).toEqual([
        "first.txt",
        "second.txt",
      ])
      expect(
        (yield* summary.diff({ sessionID: session.id, messageID: second.id })).map((change) => change.file),
      ).toEqual(["second.txt"])
    }),
  { git: true },
  30_000,
)

test("keeps diff metadata while bounding patches stored in session summaries", () => {
  const large = "a".repeat(MAX_SUMMARY_PATCH_BYTES)
  const diffs = limitSummaryPatches([
    { file: "drawing.svg", patch: "small", additions: 1, deletions: 0, status: "added" },
    { file: "log/llm-trace.log", patch: large, additions: 12_000, deletions: 0, status: "modified" },
  ])

  expect(diffs[0]?.patch).toBe("small")
  expect(diffs[1]).toEqual({
    file: "log/llm-trace.log",
    patch: undefined,
    additions: 12_000,
    deletions: 0,
    status: "modified",
  })
})
