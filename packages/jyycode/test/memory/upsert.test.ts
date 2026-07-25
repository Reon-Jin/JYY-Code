import { describe, expect, test } from "bun:test"
import path from "path"
import { AppFileSystem } from "@jyycode-ai/core/filesystem"
import { Effect, Layer } from "effect"
import { Memory } from "@/memory/memory"
import { Session } from "@/session/session"
import { SessionID } from "@/session/schema"

const firstSession = SessionID.make("ses_first")
const secondSession = SessionID.make("ses_second")

function fixture(initialUserEntries: readonly Memory.UserMemoryEntry[] = []) {
  const memoryPath = path.join(Memory.DIRECTORY, "MEMORY.json")
  const userPath = path.join(Memory.DIRECTORY, "USER.json")
  const files = new Map<string, string>([
    [memoryPath, Memory.serializeStore("memory", [])],
    [userPath, Memory.serializeStore("user", initialUserEntries)],
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
        writeFileString: (target, content) => Effect.sync(() => void files.set(target, content)),
        rename: (from, to) =>
          Effect.sync(() => {
            const content = files.get(from)
            if (content === undefined) throw new Error(`Missing mock file: ${from}`)
            files.set(to, content)
            files.delete(from)
          }),
        remove: (target) => Effect.sync(() => void files.delete(target)),
        writeWithDirs: (target, content) =>
          Effect.sync(() =>
            files.set(target, typeof content === "string" ? content : new TextDecoder().decode(content)),
          ),
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
    Memory.parseStore(scope, files.get(scope === "memory" ? memoryPath : userPath) ?? "").entries

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
            content: "用户要求赛车游戏，我用了基础建模，最终学会了碰撞结构",
          })
          const updated = yield* memory.upsertTaskMemory({
            sessionID: firstSession,
            importance: 8,
            keywords: ["赛车游戏", "地图"],
            content: "用户要求赛车地图，我用了模块拆分与绘制，最终学会了地图组织",
          })
          const second = yield* memory.upsertTaskMemory({
            sessionID: secondSession,
            importance: 4,
            keywords: ["文档"],
            content: "用户要求部署文档，我用了结构化整理，最终学会了交付规范",
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
      content: "用户要求赛车地图，我用了模块拆分与绘制，最终学会了地图组织",
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
            keywords: [" ts "],
            content: "用户偏好 TypeScript。",
          })
          const updated = yield* memory.upsertUserMemory({
            sessionID: secondSession,
            importance: 9,
            keywords: ["ts"],
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
    expect(stored.find((entry) => entry.keywords[0] === "ts")).toMatchObject({
      importance: 9,
      content: "用户长期偏好使用 TypeScript。",
    })
  })

  test("merges identical user facts even when their keywords differ", async () => {
    const { run, entries } = fixture()

    const results = await run(
      Memory.Service.use((memory) =>
        Effect.gen(function* () {
          const created = yield* memory.upsertUserMemory({
            sessionID: firstSession,
            importance: 7,
            keywords: ["技术"],
            content: "用户偏好使用 TypeScript。",
          })
          const merged = yield* memory.upsertUserMemory({
            sessionID: secondSession,
            importance: 8,
            keywords: ["偏好"],
            content: "用户偏好使用 TypeScript。",
          })
          return { created, merged }
        }),
      ),
    )

    expect(results.created.status).toBe("written")
    expect(results.merged.status).toBe("replaced")
    expect(entries("user")).toEqual([
      expect.objectContaining({
        scope: "user",
        importance: 8,
        keywords: ["偏好", "技术"],
        content: "用户偏好使用 TypeScript。",
      }),
    ])
  })

  test("consolidates existing name paraphrases and updates the profile field in place", async () => {
    const { run, entries } = fixture([
      {
        scope: "user",
        importance: 9,
        keywords: ["姓名", "称呼", "金毅阳"],
        content: '用户姓名：金毅阳。在对话中称呼用户为"金毅阳"。',
      },
      {
        scope: "user",
        importance: 5,
        keywords: ["称呼"],
        content: "用户名为金毅阳",
      },
      {
        scope: "user",
        importance: 6,
        keywords: ["姓名"],
        content: "User name is 金毅阳",
      },
      {
        scope: "user",
        importance: 8,
        keywords: ["主题"],
        content: "用户偏好深色主题。",
      },
    ])

    const updated = await run(
      Memory.Service.use((memory) =>
        memory.upsertUserMemory({
          sessionID: firstSession,
          importance: 10,
          keywords: ["名字"],
          content: "User name is 李雷",
        }),
      ),
    )

    expect(updated.status).toBe("replaced")
    const stored = entries("user") as Memory.UserMemoryEntry[]
    expect(stored).toHaveLength(2)
    expect(stored.filter((entry) => /姓名|用户名|user name/iu.test(entry.content))).toEqual([
      expect.objectContaining({
        importance: 10,
        content: "User name is 李雷",
      }),
    ])
    expect(stored).toContainEqual(
      expect.objectContaining({
        keywords: ["主题"],
        content: "用户偏好深色主题。",
      }),
    )
  })

  test("cleans equivalent stored profile facts during an unrelated user upsert", async () => {
    const { run, entries } = fixture([
      {
        scope: "user",
        importance: 9,
        keywords: ["姓名"],
        content: "用户姓名为金毅阳。",
      },
      {
        scope: "user",
        importance: 6,
        keywords: ["称呼"],
        content: "User name is 金毅阳",
      },
    ])

    await run(
      Memory.Service.use((memory) =>
        memory.upsertUserMemory({
          sessionID: firstSession,
          importance: 7,
          keywords: ["语言"],
          content: "用户偏好使用中文。",
        }),
      ),
    )

    const stored = entries("user") as Memory.UserMemoryEntry[]
    expect(stored).toHaveLength(2)
    expect(stored.filter((entry) => /姓名|user name/iu.test(entry.content))).toHaveLength(1)
    expect(stored.some((entry) => entry.content === "用户偏好使用中文。")).toBe(true)
  })

  test("recognizes equivalent birthday formats without merging unrelated facts", async () => {
    const { run, entries } = fixture()

    await run(
      Memory.Service.use((memory) =>
        Effect.gen(function* () {
          yield* memory.upsertUserMemory({
            sessionID: firstSession,
            importance: 9,
            keywords: ["生日"],
            content: "用户生日：2005年2月18日。",
          })
          yield* memory.upsertUserMemory({
            sessionID: secondSession,
            importance: 8,
            keywords: ["出生"],
            content: "User birthday is 2005-02-18.",
          })
          yield* memory.upsertUserMemory({
            sessionID: firstSession,
            importance: 7,
            keywords: ["语言"],
            content: "用户偏好使用中文。",
          })
        }),
      ),
    )

    const stored = entries("user") as Memory.UserMemoryEntry[]
    expect(stored).toHaveLength(2)
    expect(stored.filter((entry) => /生日|birthday/iu.test(entry.content))).toHaveLength(1)
    expect(stored.some((entry) => entry.content === "用户偏好使用中文。")).toBe(true)
  })

  test("rejects task upserts that do not use the required content format", async () => {
    const { run } = fixture()

    await expect(
      run(
        Memory.Service.use((memory) =>
          memory.upsertTaskMemory({
            sessionID: firstSession,
            importance: 5,
            keywords: ["格式"],
            content: "用户要求旧格式，我完成了旧结果",
          }),
        ),
      ),
    ).rejects.toThrow('expected "用户要求..." or "用户要求...，我用了...，最终学会了..."')
  })

  test("keeps enough room for a session-wide summary while bounding each section", async () => {
    const { run } = fixture()
    const request = "甲".repeat(100)
    const requestTooLong = "甲".repeat(101)
    const method = "甲".repeat(180)
    const methodTooLong = "甲".repeat(181)

    const accepted = await run(
      Memory.Service.use((memory) =>
        Effect.all([
          memory.upsertTaskMemory({
            sessionID: firstSession,
            importance: 5,
            keywords: ["边界"],
            content: `用户要求${request}`,
          }),
          memory.upsertTaskMemory({
            sessionID: secondSession,
            importance: 5,
            keywords: ["边界"],
            content: `用户要求${request}，我用了${method}，最终学会了${request}`,
          }),
        ]),
      ),
    )
    expect(accepted.map((result) => result.status)).toEqual(["written", "written"])

    await expect(
      run(
        Memory.Service.use((memory) =>
          memory.upsertTaskMemory({
            sessionID: firstSession,
            importance: 5,
            keywords: ["边界"],
            content: `用户要求${requestTooLong}`,
          }),
        ),
      ),
    ).rejects.toThrow("用户要求 must not exceed 100 characters")

    await expect(
      run(
        Memory.Service.use((memory) =>
          memory.upsertTaskMemory({
            sessionID: secondSession,
            importance: 5,
            keywords: ["边界"],
            content: `用户要求${request}，我用了${methodTooLong}，最终学会了${request}`,
          }),
        ),
      ),
    ).rejects.toThrow("我用了 must not exceed 180 characters")

    await expect(
      run(
        Memory.Service.use((memory) =>
          memory.upsertTaskMemory({
            sessionID: secondSession,
            importance: 5,
            keywords: ["边界"],
            content: `用户要求${request}，我用了${method}，最终学会了${requestTooLong}`,
          }),
        ),
      ),
    ).rejects.toThrow("最终学会了 must not exceed 100 characters")
  })
})
