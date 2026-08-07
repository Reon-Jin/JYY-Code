import { afterEach, describe, expect, test } from "bun:test"
import fs from "fs/promises"
import os from "os"
import path from "path"
import { AppFileSystem } from "@jyycode-ai/core/filesystem"
import { Effect, Exit, Layer } from "effect"
import { Memory } from "@/memory/memory"
import { Session } from "@/session/session"
import { SessionID } from "@/session/schema"

const cleanup: string[] = []

afterEach(async () => {
  await Promise.all(cleanup.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })))
})

async function fixture(input?: { failRename?: boolean }) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "memory-concurrency-"))
  cleanup.push(dir)
  const sessionLayer = Layer.mock(Session.Service)({
    get: (sessionID) => Effect.succeed({ id: sessionID, parentID: undefined } as Session.Info),
    messages: () => Effect.succeed([]),
  })
  const fsLayer = input?.failRename
    ? Layer.effect(
        AppFileSystem.Service,
        Effect.gen(function* () {
          const real = yield* AppFileSystem.Service
          return AppFileSystem.Service.of({
            ...real,
            rename: () => Effect.die("simulated atomic rename failure"),
          })
        }),
      ).pipe(Layer.provide(AppFileSystem.defaultLayer))
    : AppFileSystem.defaultLayer
  const layer = Memory.layerWithDirectory(dir).pipe(Layer.provide(Layer.merge(fsLayer, sessionLayer)))
  const run = <A, E>(effect: Effect.Effect<A, E, Memory.Service>) =>
    Effect.runPromise(effect.pipe(Effect.provide(layer)))
  return { dir, run }
}

describe("memory mutation concurrency", () => {
  test("serializes concurrent root-session upserts without lost or truncated entries", async () => {
    const { dir, run } = await fixture()
    const sessionIDs = Array.from({ length: 20 }, (_, index) => SessionID.make(`ses_concurrent_${index}`))

    await run(
      Memory.Service.use((memory) =>
        Effect.all(
          sessionIDs.map((sessionID, index) =>
            memory.upsertTaskMemory({
              sessionID,
              importance: 5,
              keywords: [`任务${index}`],
              content: `当前任务：并发任务${index}；进展：完成锁与原子写入`,
            }),
          ),
          { concurrency: "unbounded" },
        ),
      ),
    )

    const text = await fs.readFile(path.join(dir, "MEMORY.json"), "utf8")
    const entries = Memory.parseStore("memory", text).entries as Memory.TaskMemoryEntry[]
    expect(entries).toHaveLength(sessionIDs.length)
    expect(new Set(entries.map((entry) => entry.sessionID))).toEqual(new Set(sessionIDs))
    expect((await fs.readdir(dir)).filter((name) => name.includes(".tmp"))).toEqual([])
  }, 30_000)

  test("atomically replaces an existing target and leaves no temporary files", async () => {
    const { dir, run } = await fixture()
    const sessionID = SessionID.make("ses_replace_existing")
    await run(
      Memory.Service.use((memory) =>
        memory.upsertTaskMemory({
          sessionID,
          importance: 3,
          keywords: ["原始"],
          content: "当前任务：记录内容；进展：完成初始写入",
        }),
      ),
    )
    await run(
      Memory.Service.use((memory) =>
        memory.upsertTaskMemory({
          sessionID,
          importance: 8,
          keywords: ["更新"],
          content: "当前任务：更新内容；进展：完成原子替换",
        }),
      ),
    )

    expect(await fs.readFile(path.join(dir, "MEMORY.json"), "utf8")).toContain("完成原子替换")
    expect((await fs.readdir(dir)).filter((name) => name.includes(".tmp"))).toEqual([])
  })

  test("preserves the original when the atomic commit fails", async () => {
    const { dir, run } = await fixture({ failRename: true })
    const target = path.join(dir, "MEMORY.json")
    await fs.writeFile(target, Memory.serializeStore("memory", []), "utf8")
    const before = await fs.readFile(target, "utf8")

    const exit = await run(
      Effect.exit(
        Memory.Service.use((memory) =>
          memory.upsertTaskMemory({
            sessionID: SessionID.make("ses_failed_commit"),
            importance: 6,
            keywords: ["失败"],
            content: "当前任务：失败提交；进展：完成错误模拟",
          }),
        ),
      ),
    )

    expect(Exit.isFailure(exit)).toBe(true)
    expect(await fs.readFile(target, "utf8")).toBe(before)
    expect((await fs.readdir(dir)).filter((name) => name.includes(".tmp"))).toEqual([])
  })

  test("does not overwrite an invalid JSON store", async () => {
    const { dir, run } = await fixture()
    const target = path.join(dir, "MEMORY.json")
    await fs.writeFile(target, '{"schemaVersion":3,"lastCompactedAt":null,"entries":', "utf8")
    const before = await fs.readFile(target, "utf8")

    const exit = await run(
      Effect.exit(
        Memory.Service.use((memory) =>
          memory.upsertTaskMemory({
            sessionID: SessionID.make("ses_invalid_store"),
            importance: 6,
            keywords: ["无效文件"],
            content: "当前任务：无效文件；进展：完成解析校验",
          }),
        ),
      ),
    )

    expect(Exit.isFailure(exit)).toBe(true)
    expect(await fs.readFile(target, "utf8")).toBe(before)
  })
})
