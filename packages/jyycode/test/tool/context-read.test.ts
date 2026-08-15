import { afterEach, expect } from "bun:test"
import { Effect, Layer } from "effect"
import { Agent } from "@/agent/agent"
import { AppFileSystem } from "@jyycode-ai/core/filesystem"
import { CrossSpawnSpawner } from "@jyycode-ai/core/cross-spawn-spawner"
import { EffectFlock } from "@jyycode-ai/core/util/effect-flock"
import { EpisodicMemory } from "@/memory/episodic"
import { ExperienceMemory } from "@/memory/experience"
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

it.live("context_read without action defaults to the latest digest", () =>
  Effect.gen(function* () {
    const root = yield* tmpdirScoped()
    const memory = yield* EpisodicMemory.Service
    yield* memory.recordTurn({
      sessionID: ctx.sessionID,
      workspaceRoot: root,
      turn: {
        version: 1,
        sessionID: ctx.sessionID,
        turn: 1,
        time: "2026-08-07T00:00:00Z",
        userText: "修复登录",
        files: [],
        toolCalls: [],
        assistantText: "已修复",
      },
    })
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
      tool.execute({}, ctx),
    )
    expect(result.output).toContain("修复登录")
  }),
)

it.live("context_read action=experience returns matching lessons", () =>
  Effect.gen(function* () {
    const root = yield* tmpdirScoped()
    const layer = ExperienceMemory.layerWithDirectory(root).pipe(Layer.provide(AppFileSystem.defaultLayer))
    yield* Effect.gen(function* () {
      const experience = yield* ExperienceMemory.Service
      yield* experience.upsert(ctx.sessionID, {
        kind: "failure",
        importance: 8,
        keywords: ["部署"],
        content: "部署脚本报错时先看日志再重试",
        evidence: "[ses_experience_tool#1] deploy.sh",
        confidence: "high",
      }, root)
    }).pipe(Effect.provide(layer))

    const info = yield* ContextReadTool
    const tool = yield* info.init()
    const result = yield* provideInstance(root)(
      tool.execute({ action: "experience", query: "部署" }, ctx).pipe(Effect.provide(layer)),
    )
    expect(result.output).toContain("部署脚本报错时先看日志再重试")
    expect(result.output).toContain("Evidence:")
  }),
)

it.live("context_read action=experience reports no matches", () =>
  Effect.gen(function* () {
    const root = yield* tmpdirScoped()
    const info = yield* ContextReadTool
    const tool = yield* info.init()
    const layer = ExperienceMemory.layerWithDirectory(root).pipe(Layer.provide(AppFileSystem.defaultLayer))
    const result = yield* provideInstance(root)(
      tool.execute({ action: "experience", query: "不存在" }, ctx).pipe(Effect.provide(layer)),
    )
    expect(result.output).toContain("No experience matches")
  }),
)

it.live("context_read action=experience lists active entries when query is omitted", () =>
  Effect.gen(function* () {
    const root = yield* tmpdirScoped()
    const layer = ExperienceMemory.layerWithDirectory(root).pipe(Layer.provide(AppFileSystem.defaultLayer))
    yield* Effect.gen(function* () {
      const experience = yield* ExperienceMemory.Service
      yield* experience.upsert(ctx.sessionID, {
        kind: "failure",
        importance: 7,
        keywords: ["部署"],
        content: "部署脚本报错时先看日志再重试",
        evidence: "[ses_experience_tool#1] deploy.sh",
        confidence: "high",
      }, root)
      yield* experience.upsert(ctx.sessionID, {
        kind: "success",
        importance: 5,
        keywords: ["测试"],
        content: "修改认证中间件前先运行权限回归",
        evidence: "[ses_experience_tool#2] npm test",
        confidence: "medium",
      }, root)
    }).pipe(Effect.provide(layer))

    const info = yield* ContextReadTool
    const tool = yield* info.init()
    const result = yield* provideInstance(root)(
      tool.execute({ action: "experience" }, ctx).pipe(Effect.provide(layer)),
    )
    expect(result.output).toContain("部署脚本报错时先看日志再重试")
    expect(result.output).toContain("修改认证中间件前先运行权限回归")
  }),
)
