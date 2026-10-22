import { describe, expect } from "bun:test"
import { Effect, Layer, Option } from "effect"
import { AppFileSystem } from "@jyycode-ai/core/filesystem"
import { CrossSpawnSpawner } from "@jyycode-ai/core/cross-spawn-spawner"
import { EffectFlock } from "@jyycode-ai/core/util/effect-flock"
import { EpisodicMemory, episodeFromMessages, sliceLastTurns } from "@/memory/episodic"
import { MessageV2 } from "@/session/message-v2"
import { MessageID, PartID, SessionID } from "@/session/schema"
import { ModelID, ProviderID } from "@/provider/schema"
import { tmpdirScoped } from "../fixture/fixture"
import { testEffect } from "../lib/effect"

const it = testEffect(
  Layer.mergeAll(
    CrossSpawnSpawner.defaultLayer,
    AppFileSystem.defaultLayer,
    EffectFlock.defaultLayer,
    EpisodicMemory.defaultLayer,
  ),
)

const sessionID = SessionID.make("ses_episodic_test")
const testSessionID = SessionID.make("ses_test")
const testModel = { providerID: ProviderID.make("openai"), modelID: ModelID.make("gpt-4.1") }

function userMessage(id: string, text: string, synthetic = false): MessageV2.WithParts {
  const messageID = MessageID.make(`msg_${id}`)
  return {
    info: {
      id: messageID,
      sessionID: testSessionID,
      role: "user",
      time: { created: 1 },
      agent: "build",
      model: testModel,
    },
    parts: [
      {
        id: PartID.make(`prt_${id}_text`),
        messageID,
        sessionID: testSessionID,
        type: "text",
        text,
        synthetic,
      },
    ],
  }
}

function assistantMessage(id: string, parts: MessageV2.Part[], parent = "u1"): MessageV2.WithParts {
  const messageID = MessageID.make(`msg_${id}`)
  return {
    info: {
      id: messageID,
      parentID: MessageID.make(`msg_${parent}`),
      sessionID: testSessionID,
      role: "assistant",
      time: { created: 1 },
      agent: "build",
      mode: "build",
      path: { cwd: "/tmp", root: "/tmp" },
      cost: 0,
      tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
      modelID: testModel.modelID,
      providerID: testModel.providerID,
    },
    parts,
  }
}

function episode(turn: number): EpisodicMemory.EpisodeTurn {
  return {
    version: 1,
    sessionID,
    turn,
    time: new Date(Date.now() - 60_000 + turn * 1_000).toISOString(),
    userText: `user request ${turn}`,
    files: [],
    toolCalls: turn % 2 === 0 ? [{ tool: "bash", input: "ls", output: "src\n" }] : [],
    assistantText: `answer ${turn}`,
  }
}

describe("EpisodicMemory", () => {
  it.live("appends ordinary revisions without rescanning all history", () =>
    Effect.gen(function* () {
      const root = yield* tmpdirScoped()
      const fsys = yield* AppFileSystem.Service
      let reads = 0
      const mocked = AppFileSystem.Service.of({
        ...fsys,
        readFileStringSafe: (target) => {
          if (target.endsWith(".jsonl")) reads++
          return fsys.readFileStringSafe(target)
        },
      })
      yield* EpisodicMemory.Service.use((memory) =>
        Effect.gen(function* () {
          for (let step = 0; step < 5; step++) {
            yield* memory.recordTurn({
              sessionID,
              workspaceRoot: root,
              turn: { ...episode(1), assistantText: `step ${step}` },
            })
          }
          expect(reads).toBe(1)
          const latest = yield* memory.readEpisode({ sessionID, workspaceRoot: root, turn: 1 })
          expect(Option.isSome(latest) && latest.value.assistantText).toBe("step 4")
        }),
      ).pipe(Effect.provide(Layer.fresh(EpisodicMemory.layer.pipe(Layer.provide(Layer.succeed(AppFileSystem.Service, mocked))))))
    }),
  )
  it.live("bounds a heavy turn by serialized byte size", () =>
    Effect.gen(function* () {
      const root = yield* tmpdirScoped()
      const memory = yield* EpisodicMemory.Service
      const fsys = yield* AppFileSystem.Service
      yield* memory.recordTurn({
        sessionID,
        workspaceRoot: root,
        turn: {
          ...episode(1),
          assistantText: "结果".repeat(40_000),
          toolCalls: Array.from({ length: 200 }, () => ({
            tool: "bash",
            input: "命令".repeat(8_000),
            output: "输出".repeat(60_000),
          })),
        },
      })
      const raw = (yield* fsys.readFileStringSafe(EpisodicMemory.episodesPath(root, sessionID)))!
      expect(Buffer.byteLength(raw, "utf8")).toBeLessThanOrEqual(EpisodicMemory.EPISODE_TURN_MAX_BYTES + 1)
      expect(JSON.parse(raw).assistantText).toContain("结果")
      expect(JSON.parse(raw).toolCalls.length).toBeGreaterThan(0)
    }),
  )

  it.live("does not scan episodes when the digest interval is not due", () =>
    Effect.gen(function* () {
      const root = yield* tmpdirScoped()
      const fsys = yield* AppFileSystem.Service
      let reads = 0
      const mocked = AppFileSystem.Service.of({
        ...fsys,
        readFileStringSafe: (target) => {
          if (target.endsWith(".jsonl")) reads++
          return fsys.readFileStringSafe(target)
        },
      })
      yield* EpisodicMemory.Service.use((memory) =>
        Effect.gen(function* () {
          expect(yield* memory.isDigestDue({ sessionID, workspaceRoot: root, reason: "interval", totalTurns: 1 })).toBe(
            false,
          )
          expect(
            (yield* memory.compactIfDue({
              sessionID,
              workspaceRoot: root,
              reason: "interval",
              totalTurns: 1,
              generate: () => Effect.die("unexpected model call"),
            })).status,
          ).toBe("skipped")
        }),
      ).pipe(Effect.provide(Layer.fresh(EpisodicMemory.layer.pipe(Layer.provide(Layer.succeed(AppFileSystem.Service, mocked))))))
      expect(reads).toBe(0)
    }),
  )
  it.live("records and reads episodes", () =>
    Effect.gen(function* () {
      const root = yield* tmpdirScoped()
      const memory = yield* EpisodicMemory.Service
      yield* memory.recordTurn({ sessionID, workspaceRoot: root, turn: episode(1) })
      yield* memory.recordTurn({ sessionID, workspaceRoot: root, turn: episode(2) })
      const found = yield* memory.readEpisode({ sessionID, workspaceRoot: root, turn: 2 })
      expect(Option.isSome(found)).toBe(true)
      if (Option.isSome(found)) {
        expect(found.value.toolCalls[0]?.tool).toBe("bash")
      }
    }),
  )

  it.live("interval digest is due every 5 turns and keeps one five-turn window", () =>
    Effect.gen(function* () {
      const root = yield* tmpdirScoped()
      const memory = yield* EpisodicMemory.Service
      for (let turn = 1; turn <= 5; turn++) {
        yield* memory.recordTurn({ sessionID, workspaceRoot: root, turn: episode(turn) })
      }
      const before = yield* memory.compactIfDue({
        sessionID,
        workspaceRoot: root,
        reason: "interval",
        totalTurns: 4,
        generate: () => Effect.succeed("digest"),
      })
      expect(before.status).toBe("skipped")
      expect(before.reason).toBe("interval_not_due")

      const result = yield* memory.compactIfDue({
        sessionID,
        workspaceRoot: root,
        reason: "interval",
        totalTurns: 5,
        generate: () => Effect.succeed("# digest\n- done"),
      })
      expect(result.status).toBe("generated")

      const latest = yield* memory.readLatestDigest({ sessionID, workspaceRoot: root })
      expect(Option.isSome(latest)).toBe(true)
      if (Option.isSome(latest)) expect(latest.value).toContain("done")

      const again = yield* memory.compactIfDue({
        sessionID,
        workspaceRoot: root,
        reason: "interval",
        totalTurns: 5,
        generate: () => Effect.succeed("unused"),
      })
      expect(again.status).toBe("skipped")

      for (let turn = 6; turn <= 10; turn++) {
        yield* memory.recordTurn({ sessionID, workspaceRoot: root, turn: episode(turn) })
      }
      expect(yield* memory.isDigestDue({ sessionID, workspaceRoot: root, reason: "interval", totalTurns: 8 })).toBe(
        false,
      )
      expect(yield* memory.isDigestDue({ sessionID, workspaceRoot: root, reason: "interval", totalTurns: 10 })).toBe(
        true,
      )
    }),
  )

  it.live("upserts a repeated turn and reads the final revision", () =>
    Effect.gen(function* () {
      const root = yield* tmpdirScoped()
      const memory = yield* EpisodicMemory.Service
      yield* memory.recordTurn({ sessionID, workspaceRoot: root, turn: episode(7) })
      yield* memory.recordTurn({
        sessionID,
        workspaceRoot: root,
        turn: { ...episode(7), assistantText: "final answer after the second tool step" },
      })

      const found = yield* memory.readEpisode({ sessionID, workspaceRoot: root, turn: 7 })
      expect(Option.isSome(found)).toBe(true)
      if (Option.isSome(found)) expect(found.value.assistantText).toContain("final answer")
      const fs = yield* AppFileSystem.Service
      const raw = (yield* fs.readFileStringSafe(EpisodicMemory.episodesPath(root, sessionID)).pipe(Effect.orDie)) ?? ""
      expect(raw.trim().split("\n")).toHaveLength(2)
      const hits = yield* memory.searchEpisodes({ sessionID, workspaceRoot: root, query: "request 7" })
      expect(hits).toHaveLength(1)
      expect(hits[0]?.assistantText).toContain("final answer")
    }),
  )

  it.live("isDigestDue reports due only at the interval boundary", () =>
    Effect.gen(function* () {
      const root = yield* tmpdirScoped()
      const memory = yield* EpisodicMemory.Service
      for (let turn = 1; turn <= 5; turn++) {
        yield* memory.recordTurn({ sessionID, workspaceRoot: root, turn: episode(turn) })
      }
      expect(yield* memory.isDigestDue({ sessionID, workspaceRoot: root, reason: "interval", totalTurns: 4 })).toBe(
        false,
      )
      expect(yield* memory.isDigestDue({ sessionID, workspaceRoot: root, reason: "interval", totalTurns: 5 })).toBe(
        true,
      )
    }),
  )

  it.live("searchEpisodes finds keyword matches", () =>
    Effect.gen(function* () {
      const root = yield* tmpdirScoped()
      const memory = yield* EpisodicMemory.Service
      yield* memory.recordTurn({ sessionID, workspaceRoot: root, turn: episode(1) })
      yield* memory.recordTurn({ sessionID, workspaceRoot: root, turn: episode(2) })
      const hits = yield* memory.searchEpisodes({ sessionID, workspaceRoot: root, query: "request 2" })
      expect(hits.length).toBe(1)
      expect(hits[0]?.turn).toBe(2)
    }),
  )

  it.live("episodeFromMessages aggregates tool calls and assistant text", () =>
    Effect.gen(function* () {
      const messages: MessageV2.WithParts[] = [
        userMessage("u1", "第一轮"),
        assistantMessage("a1", []),
        userMessage("u2", "第二轮"),
        assistantMessage(
          "a2",
          [
            {
              id: PartID.make("prt_a2_tool"),
              messageID: MessageID.make("msg_a2"),
              sessionID: testSessionID,
              type: "tool",
              callID: "call_1",
              tool: "bash",
              state: {
                status: "completed",
                input: { command: "ls" },
                output: "src\n",
                title: "x",
                metadata: {},
                time: { start: 1, end: 2 },
              },
            },
            {
              id: PartID.make("prt_a2_text"),
              messageID: MessageID.make("msg_a2"),
              sessionID: testSessionID,
              type: "text",
              text: "完成",
            },
          ],
          "u2",
        ),
      ]
      const episode = episodeFromMessages(messages)
      expect(episode.turn).toBe(2)
      expect(episode.toolCalls[0]?.tool).toBe("bash")
      expect(episode.assistantText).toBe("完成")
      expect(sliceLastTurns(messages, 2).length).toBe(messages.length)
    }),
  )
})
