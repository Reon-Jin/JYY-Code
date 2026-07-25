import { afterEach, describe, expect, test } from "bun:test"
import fs from "fs/promises"
import os from "os"
import path from "path"
import { AppFileSystem } from "@jyycode-ai/core/filesystem"
import { Effect, Layer } from "effect"
import { Memory } from "@/memory/memory"
import { Session } from "@/session/session"
import { SessionID } from "@/session/schema"

const cleanup: string[] = []
const sessionID = SessionID.make("ses_snapshot")

afterEach(async () => {
  await Promise.all(cleanup.splice(0).map((directory) => fs.rm(directory, { recursive: true, force: true })))
})

test("session snapshot contains only the top 10 entries from each store", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "memory-snapshot-"))
  cleanup.push(directory)
  const entries = Array.from(
    { length: 15 },
    (_, index): Memory.TaskMemoryEntry => ({
      scope: "memory",
      sessionID: SessionID.make(`ses_snapshot_${index}`),
      importance: (index < 10 ? 10 : 1) as Memory.Importance,
      date: `202607${String((index % 6) + 1).padStart(2, "0")}`,
      keywords: [`条目${index}`],
      content: `快照内容 ${index}。`,
    }),
  )
  await fs.writeFile(path.join(directory, "MEMORY.json"), Memory.serializeStore("memory", entries))
  const userEntries = Array.from(
    { length: 15 },
    (_, index): Memory.UserMemoryEntry => ({
      scope: "user",
      importance: (index < 10 ? 10 : 1) as Memory.Importance,
      keywords: [`偏好${index}`],
      content: `用户偏好 ${index}。`,
    }),
  )
  await fs.writeFile(path.join(directory, "USER.json"), Memory.serializeStore("user", userEntries))
  const sessions = Layer.mock(Session.Service)({
    get: (id) => Effect.succeed({ id, parentID: undefined } as Session.Info),
    messages: () => Effect.succeed([]),
  })
  const layer = Memory.layerWithDirectory(directory).pipe(
    Layer.provide(Layer.merge(AppFileSystem.defaultLayer, sessions)),
  )
  const snapshots = await Effect.runPromise(
    Memory.Service.use((memory) =>
      Effect.all([memory.formatWithHeader(sessionID, "memory"), memory.formatWithHeader(sessionID, "user")]),
    ).pipe(Effect.provide(layer)),
  )
  const snapshot = snapshots.join("\n")

  expect(snapshots[0].split(/\r?\n/u).filter((line) => line.startsWith("- "))).toHaveLength(10)
  expect(snapshots[1].split(/\r?\n/u).filter((line) => line.startsWith("- "))).toHaveLength(10)
  expect(snapshot.split(/\r?\n/u).filter((line) => line.startsWith("- "))).toHaveLength(20)
  expect(snapshot).toContain("importance=10")
  expect(snapshot).not.toContain("importance=1 |")
  expect(snapshot).not.toContain("schemaVersion")
  expect(snapshot).not.toContain('"entries"')
})
