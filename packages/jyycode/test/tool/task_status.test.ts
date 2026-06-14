import { afterEach, describe, expect } from "bun:test"
import { Effect, Layer } from "effect"
import { Agent } from "@/agent/agent"
import { BackgroundJob } from "@/background/job"
import { Bus } from "@/bus"
import { CrossSpawnSpawner } from "@jyycode-ai/core/cross-spawn-spawner"
import { Session } from "@/session/session"
import { MessageV2 } from "@/session/message-v2"
import { MessageID, PartID } from "@/session/schema"
import { SessionStatus } from "@/session/status"
import { TaskStatusTool } from "@/tool/task_status"
import { Truncate } from "@/tool/truncate"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { ModelID, ProviderID } from "@/provider/schema"
import { disposeAllInstances } from "../fixture/fixture"
import { testEffect } from "../lib/effect"

afterEach(async () => {
  await disposeAllInstances()
})

const layer = (flags: Partial<RuntimeFlags.Info> = {}) =>
  Layer.mergeAll(
    Agent.defaultLayer,
    BackgroundJob.defaultLayer,
    Bus.defaultLayer,
    CrossSpawnSpawner.defaultLayer,
    Session.defaultLayer,
    SessionStatus.defaultLayer,
    Truncate.defaultLayer,
    RuntimeFlags.layer(flags),
  )

const it = testEffect(layer({ experimentalBackgroundSubagents: true }))
const cluster = testEffect(layer())

const ref = {
  providerID: ProviderID.make("test"),
  modelID: ModelID.make("test-model"),
}

describe("tool.task_status", () => {
  cluster.instance("cluster agent can inspect background jobs without the experiment flag", () =>
    Effect.gen(function* () {
      const jobs = yield* BackgroundJob.Service
      const sessions = yield* Session.Service
      const tool = yield* TaskStatusTool
      const def = yield* tool.init()
      const chat = yield* sessions.create({})

      yield* jobs.start({ id: chat.id, type: "task", run: Effect.succeed("cluster done") })

      const result = yield* def.execute(
        { task_id: chat.id, wait: true, timeout_ms: 1_000 },
        {
          sessionID: chat.id,
          messageID: MessageID.ascending(),
          agent: "cluster",
          abort: new AbortController().signal,
          messages: [],
          metadata: () => Effect.void,
          ask: () => Effect.void,
        },
      )

      expect(result.output).toContain("state: completed")
      expect(result.output).toContain("cluster done")
    }),
  )

  it.instance("returns completed background job output", () =>
    Effect.gen(function* () {
      const jobs = yield* BackgroundJob.Service
      const sessions = yield* Session.Service
      const tool = yield* TaskStatusTool
      const def = yield* tool.init()
      const chat = yield* sessions.create({})

      yield* jobs.start({ id: chat.id, type: "task", run: Effect.succeed("all done") })

      const result = yield* def.execute(
        { task_id: chat.id, wait: true, timeout_ms: 1_000 },
        {
          sessionID: chat.id,
          messageID: MessageID.ascending(),
          agent: "build",
          abort: new AbortController().signal,
          messages: [],
          metadata: () => Effect.void,
          ask: () => Effect.void,
        },
      )

      expect(result.output).toContain("state: completed")
      expect(result.output).toContain("all done")
      expect(result.metadata.timed_out).toBe(false)
    }),
  )

  it.instance("preserves reported subagent status header", () =>
    Effect.gen(function* () {
      const sessions = yield* Session.Service
      const tool = yield* TaskStatusTool
      const def = yield* tool.init()
      const chat = yield* sessions.create({})
      const parentID = MessageID.ascending()
      const assistantID = MessageID.ascending()
      const text = [
        "**Status**: partial",
        "**Summary**: completed investigation but tests missing",
        "",
        "Investigation notes.",
      ].join("\n")

      yield* sessions.updateMessage({
        id: parentID,
        role: "user",
        sessionID: chat.id,
        agent: "build",
        model: ref,
        time: { created: Date.now() },
      } as MessageV2.User)
      yield* sessions.updateMessage({
        id: assistantID,
        role: "assistant",
        parentID,
        sessionID: chat.id,
        mode: "build",
        agent: "build",
        cost: 0,
        path: { cwd: "/tmp", root: "/tmp" },
        tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
        modelID: ref.modelID,
        providerID: ref.providerID,
        time: { created: Date.now() },
        finish: "stop",
      } satisfies MessageV2.Assistant)
      yield* sessions.updatePart({
        id: PartID.ascending(),
        messageID: assistantID,
        sessionID: chat.id,
        type: "text",
        text,
      })

      const result = yield* def.execute(
        { task_id: chat.id },
        {
          sessionID: chat.id,
          messageID: MessageID.ascending(),
          agent: "build",
          abort: new AbortController().signal,
          messages: [],
          metadata: () => Effect.void,
          ask: () => Effect.void,
        },
      )

      expect(result.output).toContain("state: completed")
      expect(result.metadata.reported_status).toBe("partial")
    }),
  )

  it.instance("wait=true times out while the background job is running", () =>
    Effect.gen(function* () {
      const jobs = yield* BackgroundJob.Service
      const sessions = yield* Session.Service
      const tool = yield* TaskStatusTool
      const def = yield* tool.init()
      const chat = yield* sessions.create({})

      yield* jobs.start({ id: chat.id, type: "task", run: Effect.never })

      const result = yield* def.execute(
        { task_id: chat.id, wait: true, timeout_ms: 50 },
        {
          sessionID: chat.id,
          messageID: MessageID.ascending(),
          agent: "build",
          abort: new AbortController().signal,
          messages: [],
          metadata: () => Effect.void,
          ask: () => Effect.void,
        },
      )

      expect(result.output).toContain("state: running")
      expect(result.output).toContain("Timed out after 50ms")
      expect(result.metadata.timed_out).toBe(true)
    }),
  )
})
