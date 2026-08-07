import { afterEach, describe, expect } from "bun:test"
import { Effect, Layer } from "effect"
import { Agent } from "@/agent/agent"
import { AppFileSystem } from "@jyycode-ai/core/filesystem"
import { CrossSpawnSpawner } from "@jyycode-ai/core/cross-spawn-spawner"
import { EffectFlock } from "@jyycode-ai/core/util/effect-flock"
import { EpisodicMemory } from "@/memory/episodic"
import { SessionID, MessageID } from "@/session/schema"
import { ContextReadTool } from "@/tool/context-read"
import { Tool } from "@/tool/tool"
import { Truncate } from "@/tool/truncate"
import { disposeAllInstances, provideInstance, tmpdirScoped } from "../fixture/fixture"
import { testEffect } from "../lib/effect"

afterEach(async () => {
  await disposeAllInstances()
})

const toolLayer = Layer.mergeAll(
  CrossSpawnSpawner.defaultLayer,
  Agent.defaultLayer,
  AppFileSystem.defaultLayer,
  EffectFlock.defaultLayer,
  Truncate.defaultLayer,
  EpisodicMemory.defaultLayer,
)
const it = testEffect(toolLayer)

const ctx: Tool.Context = {
  sessionID: SessionID.make("ses_context_read"),
  messageID: MessageID.make("msg_test"),
  callID: "",
  agent: "build",
  abort: AbortSignal.any([]),
  messages: [],
  metadata: () => Effect.void,
  ask: () => Effect.void,
}

it.live("context_read returns the latest digest", () =>
  Effect.gen(function* () {
    const root = yield* tmpdirScoped()
    const memory = yield* EpisodicMemory.Service
    for (let turn = 1; turn <= 3; turn++) {
      yield* memory.recordTurn({
        sessionID: ctx.sessionID,
        workspaceRoot: root,
        turn: {
          version: 1,
          sessionID: ctx.sessionID,
          turn,
          time: "2026-08-07T00:00:00Z",
          userText: "修复登录",
          files: [],
          toolCalls: [],
          assistantText: "已修复",
        },
      })
    }
    yield* memory.compactIfDue({
      sessionID: ctx.sessionID,
      workspaceRoot: root,
      reason: "threshold",
      totalTurns: 3,
      generate: () => Effect.succeed("## 已完成\n- 修复登录"),
    })

    const info = yield* ContextReadTool
    const tool = yield* info.init()
    const result = yield* provideInstance(root)(
      tool.execute({ action: "digest" }, ctx),
    )
    expect(result.output).toContain("修复登录")
  }),
)
