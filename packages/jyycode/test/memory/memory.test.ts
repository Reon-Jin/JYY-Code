import { afterEach, describe, expect, test } from "bun:test"
import fs from "fs/promises"
import os from "os"
import path from "path"
import { Global } from "@jyycode-ai/core/global"
import { AppFileSystem } from "@jyycode-ai/core/filesystem"
import { Effect, Layer } from "effect"
import { Memory } from "@/memory/memory"
import { Session } from "@/session/session"
import { SessionID } from "@/session/schema"

const cleanup: string[] = []
const sessionID = SessionID.make("ses_memory_read")

afterEach(async () => {
  await Promise.all(cleanup.splice(0).map((directory) => fs.rm(directory, { recursive: true, force: true })))
})

async function withMemory<T>(run: (memory: Memory.Interface) => Effect.Effect<T, unknown>) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "memory-read-"))
  cleanup.push(directory)
  await fs.writeFile(
    path.join(directory, "MEMORY.json"),
    Memory.serializeStore("memory", [
      {
        scope: "memory",
        sessionID,
        importance: 7,
        date: "20260808",
        keywords: ["娴嬭瘯"],
        projectID: "project-read",
        content: "褰撳墠浠诲姟锛氭祴璇曞垎绔э紱杩涘睍锛氭湁鏁堟灉",
      },
    ]),
    "utf8",
  )
  await fs.writeFile(
    path.join(directory, "USER.json"),
    Memory.serializeStore("user", [
      {
        scope: "user",
        importance: 8,
        keywords: ["鐢ㄦ埛"],
        content: "鐢ㄦ埛鍋忓ソ涓枃鍥炵瓟",
      },
    ]),
    "utf8",
  )
  const sessionLayer = Layer.mock(Session.Service)({
    get: (id) => Effect.succeed({ id, parentID: undefined, projectID: "project-read" } as Session.Info),
    messages: () => Effect.succeed([]),
  })
  const layer = Memory.layerWithDirectory(directory).pipe(
    Layer.provide(Layer.merge(AppFileSystem.defaultLayer, sessionLayer)),
  )
  return Effect.runPromise(
    Effect.gen(function* () {
      const memory = yield* Memory.Service
      return yield* run(memory)
    }).pipe(Effect.provide(layer)),
  )
}

describe("memory", () => {
  test("uses the platform data directory as the canonical memory store", () => {
    expect(Memory.LEGACY_DIRECTORY).toBe(path.normalize("D:/jyycode/memory"))
    expect(Memory.DIRECTORY).toBe(path.join(Global.Path.data, "memory"))
  })

  test("empty stores use the v3 JSON envelope", () => {
    expect(JSON.parse(Memory.serializeStore("memory", []))).toEqual({
      schemaVersion: 3,
      lastCompactedAt: null,
      entries: [],
    })
  })

  test("read section=task and section=user select only the requested store", async () => {
    await withMemory((memory) =>
      Effect.gen(function* () {
        const task = Memory.parseStore(
          "memory",
          yield* memory.read({ sessionID, scope: "memory", section: "task" }),
        )
        const user = Memory.parseStore(
          "user",
          yield* memory.read({ sessionID, scope: "memory", section: "user" }),
        )

        expect(task.entries.every((entry) => entry.scope === "memory")).toBe(true)
        expect(user.entries.every((entry) => entry.scope === "user")).toBe(true)
        expect(task.entries).toHaveLength(1)
        expect(user.entries).toHaveLength(1)
      }),
    )
  })

  test("read without section preserves the requested scope serialization", async () => {
    await withMemory((memory) =>
      Effect.gen(function* () {
        const text = yield* memory.read({ sessionID, scope: "memory" })
        expect(text).toBe(
          Memory.serializeStore("memory", [
            {
              scope: "memory",
              sessionID,
              importance: 7,
              date: "20260808",
              keywords: ["娴嬭瘯"],
              projectID: "project-read",
              content: "褰撳墠浠诲姟锛氭祴璇曞垎绔э紱杩涘睍锛氭湁鏁堟灉",
            },
          ]),
        )
      }),
    )
  })

  test("invalid read sections fail as recoverable errors", async () => {
    await expect(
      withMemory((memory) => memory.read({ sessionID, scope: "memory", section: "invalid" })),
    ).rejects.toThrow("Invalid memory section")
  })
})
