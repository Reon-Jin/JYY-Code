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
    time: `2026-08-07T00:00:0${turn}Z`,
    userText: `user request ${turn}`,
    files: [],
    toolCalls: turn % 2 === 0 ? [{ tool: "bash", input: "ls", output: "src\n" }] : [],
    assistantText: `answer ${turn}`,
  }
}

describe("EpisodicMemory", () => {
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

  it.live("interval digest is due every 5 turns and keeps last 2 turns", () =>
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
    }),
  )

  it.live("isDigestDue reports due only at the interval boundary", () =>
    Effect.gen(function* () {
      const root = yield* tmpdirScoped()
      const memory = yield* EpisodicMemory.Service
      for (let turn = 1; turn <= 5; turn++) {
        yield* memory.recordTurn({ sessionID, workspaceRoot: root, turn: episode(turn) })
      }
      expect(
        yield* memory.isDigestDue({ sessionID, workspaceRoot: root, reason: "interval", totalTurns: 4 }),
      ).toBe(false)
      expect(
        yield* memory.isDigestDue({ sessionID, workspaceRoot: root, reason: "interval", totalTurns: 5 }),
      ).toBe(true)
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
        assistantMessage("a2", [
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
        ], "u2"),
      ]
      const episode = episodeFromMessages(messages)
      expect(episode.turn).toBe(2)
      expect(episode.toolCalls[0]?.tool).toBe("bash")
      expect(episode.assistantText).toBe("完成")
      expect(sliceLastTurns(messages, 2).length).toBe(messages.length)
    }),
  )
})
