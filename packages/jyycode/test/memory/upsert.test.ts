import { describe, expect, test } from "bun:test"
import path from "path"
import { AppFileSystem } from "@jyycode-ai/core/filesystem"
import { Effect, Layer } from "effect"
import { Memory } from "@/memory/memory"
import { Session } from "@/session/session"
import { SessionID } from "@/session/schema"

const firstSession = SessionID.make("ses_first")
const secondSession = SessionID.make("ses_second")

function fixture() {
  const memoryPath = path.join(Memory.DIRECTORY, "MEMORY.md")
  const userPath = path.join(Memory.DIRECTORY, "USER.md")
  const files = new Map<string, string>([
    [memoryPath, "# JYY-Code Memory\n\n<!-- schema: 2; last_compacted: never -->\n"],
    [userPath, "# User Memory\n\n<!-- schema: 2; last_compacted: never -->\n"],
  ])
  const fsLayer = Layer.effect(
    AppFileSystem.Service,
    Effect.gen(function* () {
      const fs = yield* AppFileSystem.Service
      return AppFileSystem.Service.of({
        ...fs,
        ensureDir: () => Effect.void,
        existsSafe: (target) => Effect.succeed(files.has(target)),
        readFileStringSafe: (target) => Effect.succeed(files.get(target)),
        writeWithDirs: (target, content) =>
          Effect.sync(() => files.set(target, typeof content === "string" ? content : new TextDecoder().decode(content))),
      })
    }),
  ).pipe(Layer.provide(AppFileSystem.defaultLayer))
  const sessionLayer = Layer.mock(Session.Service)({
    get: (sessionID) => Effect.succeed({ id: sessionID, parentID: undefined } as Session.Info),
    messages: () => Effect.succeed([]),
  })
  const layer = Memory.layer.pipe(Layer.provide(Layer.merge(fsLayer, sessionLayer)))
  const run = <A, E>(effect: Effect.Effect<A, E, Memory.Service>) =>
    Effect.runPromise(effect.pipe(Effect.provide(layer)))
  const entries = (scope: Memory.Scope) =>
    (files.get(scope === "memory" ? memoryPath : userPath) ?? "")
      .split(/\r?\n/u)
      .filter((line) => line.startsWith("- "))
      .map((line) => Memory.parseEntry(scope, line))

  return { run, entries }
}

describe("structured memory upserts", () => {
  test("keeps exactly one task entry per session and updates its fields", async () => {
    const { run, entries } = fixture()
    const results = await run(
      Memory.Service.use((memory) =>
        Effect.gen(function* () {
          const created = yield* memory.upsertTaskMemory({
            sessionID: firstSession,
            importance: 5,
            keywords: ["赛车游戏"],
            content: "完成赛车游戏基础建模。",
          })
          const updated = yield* memory.upsertTaskMemory({
            sessionID: firstSession,
            importance: 8,
            keywords: ["赛车游戏", "地图"],
            content: "完成赛车建模并加入地图绘制。",
          })
          const second = yield* memory.upsertTaskMemory({
            sessionID: secondSession,
            importance: 4,
            keywords: ["文档"],
            content: "完成部署文档。",
          })
          return { created, updated, second }
        }),
      ),
    )

    expect(results.created.status).toBe("written")
    expect(results.updated.status).toBe("replaced")
    expect(results.second.status).toBe("written")
    const stored = entries("memory") as Memory.TaskMemoryEntry[]
    expect(stored).toHaveLength(2)
    expect(stored.filter((entry) => entry.sessionID === firstSession)).toHaveLength(1)
    expect(stored.find((entry) => entry.sessionID === firstSession)).toMatchObject({
      importance: 8,
      keywords: ["赛车游戏", "地图"],
      content: "完成赛车建模并加入地图绘制。",
    })
    expect(stored[0]!.date).toMatch(/^\d{8}$/u)
  })

  test("uses normalized user keywords as the unique key", async () => {
    const { run, entries } = fixture()
    const results = await run(
      Memory.Service.use((memory) =>
        Effect.gen(function* () {
          const created = yield* memory.upsertUserMemory({
            sessionID: firstSession,
            importance: 7,
            keywords: [" TypeScript "],
            content: "用户偏好 TypeScript。",
          })
          const updated = yield* memory.upsertUserMemory({
            sessionID: secondSession,
            importance: 9,
            keywords: ["typescript"],
            content: "用户长期偏好使用 TypeScript。",
          })
          const second = yield* memory.upsertUserMemory({
            sessionID: firstSession,
            importance: 10,
            keywords: ["姓名"],
            content: "用户姓名为金毅阳。",
          })
          const duplicate = yield* memory.upsertUserMemory({
            sessionID: firstSession,
            importance: 10,
            keywords: ["姓名"],
            content: "用户姓名为金毅阳。",
          })
          return { created, updated, second, duplicate }
        }),
      ),
    )

    expect(results.created.status).toBe("written")
    expect(results.updated.status).toBe("replaced")
    expect(results.second.status).toBe("written")
    expect(results.duplicate.status).toBe("duplicate")
    const stored = entries("user") as Memory.UserMemoryEntry[]
    expect(stored).toHaveLength(2)
    expect(stored.find((entry) => entry.keywords[0] === "typescript")).toMatchObject({
      importance: 9,
      content: "用户长期偏好使用 TypeScript。",
    })
  })
})
