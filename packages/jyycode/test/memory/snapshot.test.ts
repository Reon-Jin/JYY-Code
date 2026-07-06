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

test("session snapshot contains only the top 20 formatted entries", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "memory-snapshot-"))
  cleanup.push(directory)
  const entries = Array.from({ length: 25 }, (_, index): Memory.TaskMemoryEntry => ({
    scope: "memory",
    sessionID: SessionID.make(`ses_snapshot_${index}`),
    importance: (index < 20 ? 10 : 1) as Memory.Importance,
    date: `202607${String((index % 6) + 1).padStart(2, "0")}`,
    keywords: [`条目${index}`],
    content: `快照内容 ${index}。`,
  }))
  await fs.writeFile(path.join(directory, "MEMORY.json"), Memory.serializeStore("memory", entries))
  await fs.writeFile(path.join(directory, "USER.json"), Memory.serializeStore("user", []))
  const sessions = Layer.mock(Session.Service)({
    get: (id) => Effect.succeed({ id, parentID: undefined } as Session.Info),
    messages: () => Effect.succeed([]),
  })
  const layer = Memory.layerWithDirectory(directory).pipe(
    Layer.provide(Layer.merge(AppFileSystem.defaultLayer, sessions)),
  )
  const snapshot = await Effect.runPromise(
    Memory.Service.use((memory) => memory.formatWithHeader(sessionID, "memory")).pipe(Effect.provide(layer)),
  )

  expect(snapshot.split(/\r?\n/u).filter((line) => line.startsWith("- "))).toHaveLength(20)
  expect(snapshot).toContain("importance=10")
  expect(snapshot).not.toContain("importance=1 |")
  expect(snapshot).not.toContain("schemaVersion")
  expect(snapshot).not.toContain('"entries"')
})
