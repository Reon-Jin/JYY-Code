import { describe, expect } from "bun:test"
import { Effect, Layer, Option } from "effect"
import { AppFileSystem } from "@jyycode-ai/core/filesystem"
import { CrossSpawnSpawner } from "@jyycode-ai/core/cross-spawn-spawner"
import { SessionState } from "@/session/state"
import { tmpdirScoped } from "../fixture/fixture"
import { testEffect } from "../lib/effect"

const it = testEffect(Layer.mergeAll(CrossSpawnSpawner.defaultLayer, AppFileSystem.defaultLayer))

describe("SessionState", () => {
  it.live("round-trips a session state file", () =>
    Effect.gen(function* () {
      const dir = yield* tmpdirScoped()
      const fsys = yield* AppFileSystem.Service
      const state = {
        version: 1 as const,
        updatedAt: "2026-08-07T00:00:00.000Z",
        lastUser: "fix the auth bug",
        lastAssistant: "updated refresh token handling",
        lastToolNames: ["edit", "grep"],
        tailStartID: "msg_tail_1",
        summary: "Auth refresh token support implemented.",
      }

      yield* SessionState.writeSessionState(fsys, dir, "ses_state", state)

      const read = yield* SessionState.readSessionState(fsys, dir, "ses_state")
      expect(Option.isSome(read)).toBe(true)
      if (Option.isSome(read)) {
        expect(read.value).toEqual(state)
        expect(SessionState.formatSessionState(read.value)).toContain("## Rolling summary")
        expect(SessionState.formatSessionState(read.value)).toContain("fix the auth bug")
      }
    }),
  )

  it.live("returns none when no state file exists", () =>
    Effect.gen(function* () {
      const dir = yield* tmpdirScoped()
      const fsys = yield* AppFileSystem.Service
      const read = yield* SessionState.readSessionState(fsys, dir, "ses_missing")
      expect(Option.isNone(read)).toBe(true)
    }),
  )
})
