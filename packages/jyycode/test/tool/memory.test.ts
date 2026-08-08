import { afterEach, expect } from "bun:test"
import fs from "fs/promises"
import { AppFileSystem } from "@jyycode-ai/core/filesystem"
import { CrossSpawnSpawner } from "@jyycode-ai/core/cross-spawn-spawner"
import { EffectFlock } from "@jyycode-ai/core/util/effect-flock"
import { Effect, Layer } from "effect"
import { Agent } from "@/agent/agent"
import { Memory } from "@/memory/memory"
import { Session } from "@/session/session"
import { SessionID, MessageID } from "@/session/schema"
import { MemoryTool } from "@/tool/memory"
import { Tool } from "@/tool/tool"
import { Truncate } from "@/tool/truncate"
import { disposeAllInstances, provideInstance, tmpdirScoped } from "../fixture/fixture"
import { testEffect } from "../lib/effect"

const cleanup: string[] = []

afterEach(async () => {
  await disposeAllInstances()
  await Promise.all(cleanup.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })))
})

const ctx: Tool.Context = {
  sessionID: SessionID.make("ses_memory_tool"),
  messageID: MessageID.make("msg_memory_tool"),
  callID: "",
  agent: "build",
  abort: AbortSignal.any([]),
  messages: [],
  metadata: () => Effect.void,
  ask: () => Effect.void,
}

const it = testEffect(
  Layer.mergeAll(
    Agent.defaultLayer,
    CrossSpawnSpawner.defaultLayer,
    AppFileSystem.defaultLayer,
    EffectFlock.defaultLayer,
    Truncate.defaultLayer,
  ),
)

it.live("memory tool read returns the selected store without mutation", () =>
  Effect.gen(function* () {
    const root = yield* tmpdirScoped()
    cleanup.push(root)
    const sessionLayer = Layer.mock(Session.Service)({
      get: (id) => Effect.succeed({ id, parentID: undefined } as Session.Info),
      messages: () => Effect.succeed([]),
    })
    const layer = Memory.layerWithDirectory(root).pipe(
      Layer.provide(Layer.merge(AppFileSystem.defaultLayer, sessionLayer)),
    )
    const result = yield* Effect.gen(function* () {
      const memory = yield* Memory.Service
      yield* memory.upsertUserMemory({
        sessionID: ctx.sessionID,
        importance: 9,
        keywords: ["中文"],
        content: "用户偏好中文回答",
      })
      const info = yield* MemoryTool
      const tool = yield* info.init()
      return yield* provideInstance(root)(tool.execute({ action: "read", target: "user" }, ctx))
    }).pipe(Effect.provide(layer))

    expect(result.output).toContain("用户偏好中文回答")
    expect(result.metadata?.file).toContain("USER.json")
  }),
)

it.live("memory tool returns input errors without defecting", () =>
  Effect.gen(function* () {
    const root = yield* tmpdirScoped()
    cleanup.push(root)
    const sessionLayer = Layer.mock(Session.Service)({
      get: (id) => Effect.succeed({ id, parentID: undefined } as Session.Info),
      messages: () => Effect.succeed([]),
    })
    const layer = Memory.layerWithDirectory(root).pipe(
      Layer.provide(Layer.merge(AppFileSystem.defaultLayer, sessionLayer)),
    )
    const result = yield* Effect.gen(function* () {
      const info = yield* MemoryTool
      const tool = yield* info.init()
      return yield* provideInstance(root)(tool.execute({ action: "add", target: "user" }, ctx))
    }).pipe(Effect.provide(layer))

    expect(result.metadata?.status).toBe("error")
    expect(result.output).toContain("content is required")
  }),
)
