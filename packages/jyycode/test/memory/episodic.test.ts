import { describe, expect } from "bun:test"
import { Effect, Layer, Option } from "effect"
import { AppFileSystem } from "@jyycode-ai/core/filesystem"
import { CrossSpawnSpawner } from "@jyycode-ai/core/cross-spawn-spawner"
import { EffectFlock } from "@jyycode-ai/core/util/effect-flock"
import { EpisodicMemory } from "@/memory/episodic"
import { SessionID } from "@/session/schema"
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
})
