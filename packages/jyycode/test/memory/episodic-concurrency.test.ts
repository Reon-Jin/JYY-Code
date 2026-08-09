import { afterEach, describe, expect, test } from "bun:test"
import fs from "fs/promises"
import os from "os"
import path from "path"
import { Effect, Layer } from "effect"
import { AppFileSystem } from "@jyycode-ai/core/filesystem"
import { EpisodicMemory } from "../../src/memory/episodic"
import { SessionID } from "../../src/session/schema"

const directories: string[] = []

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => fs.rm(directory, { recursive: true, force: true })))
})

function episode(sessionID: SessionID, turn: number): EpisodicMemory.EpisodeTurn {
  return {
    version: 1,
    sessionID,
    turn,
    time: `2026-08-08T00:00:${String(turn).padStart(2, "0")}Z`,
    userText: `request ${turn}`,
    files: [],
    toolCalls: [],
    assistantText: `answer ${turn}`,
  }
}

async function withStore<T>(run: (service: EpisodicMemory.Interface, root: string) => Promise<T>): Promise<T> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "episodic-concurrency-"))
  directories.push(root)
  const layer = EpisodicMemory.defaultLayer.pipe(Layer.provide(AppFileSystem.defaultLayer))
  return Effect.runPromise(
    EpisodicMemory.Service.use((service) => Effect.promise(() => run(service, root))).pipe(Effect.provide(layer)),
  )
}

describe("episodic digest concurrency", () => {
  test("serializes same-coverage compactions and keeps sequence/index entries", async () => {
    await withStore(async (service, root) => {
      const sessionID = SessionID.make("ses_episodic_parallel")
      for (let turn = 1; turn <= 5; turn++) {
        await Effect.runPromise(service.recordTurn({ sessionID, workspaceRoot: root, turn: episode(sessionID, turn) }))
      }

      let generateCalls = 0
      const results = await Promise.all(
        Array.from({ length: 2 }, () =>
          Effect.runPromise(
            service.compactIfDue({
              sessionID,
              workspaceRoot: root,
              reason: "interval",
              totalTurns: 5,
              generate: () =>
                Effect.sync(() => {
                  generateCalls++
                  return "# digest 1"
                }),
            }),
          ),
        ),
      )

      const index = JSON.parse(await fs.readFile(EpisodicMemory.digestIndexPath(root, sessionID), "utf8")) as {
        latestSeq: number
        coveredTurns: number
        entries: Array<{ seq: number }>
      }
      expect(generateCalls).toBe(1)
      expect(results.filter((result) => result.status === "generated")).toHaveLength(1)
      expect(results.filter((result) => result.status === "skipped")).toHaveLength(1)
      expect(index.latestSeq).toBe(1)
      expect(index.coveredTurns).toBe(5)
      expect(index.entries.map((entry) => entry.seq)).toEqual([1])
    })
  })

  test("appends the next digest from the latest covered turn", async () => {
    await withStore(async (service, root) => {
      const sessionID = SessionID.make("ses_episodic_progress")
      for (let turn = 1; turn <= 10; turn++) {
        await Effect.runPromise(service.recordTurn({ sessionID, workspaceRoot: root, turn: episode(sessionID, turn) }))
      }

      await Effect.runPromise(
        service.compactIfDue({
          sessionID,
          workspaceRoot: root,
          reason: "interval",
          totalTurns: 5,
          generate: () => Effect.succeed("# digest 1"),
        }),
      )
      const results = await Promise.all(
        Array.from({ length: 2 }, () =>
          Effect.runPromise(
            service.compactIfDue({
              sessionID,
              workspaceRoot: root,
              reason: "interval",
              totalTurns: 10,
              generate: () => Effect.succeed("# digest 2"),
            }),
          ),
        ),
      )

      const index = JSON.parse(await fs.readFile(EpisodicMemory.digestIndexPath(root, sessionID), "utf8")) as {
        latestSeq: number
        coveredTurns: number
        entries: Array<{ seq: number; turnStart: number; turnEnd: number; parentSeq: number | null }>
      }
      expect(results.filter((result) => result.status === "generated")).toHaveLength(1)
      expect(index.latestSeq).toBe(2)
      expect(index.coveredTurns).toBe(10)
      expect(index.entries).toHaveLength(2)
      expect(index.entries[1]).toMatchObject({ seq: 2, turnStart: 6, turnEnd: 10, parentSeq: 1 })
    })
  })
})
