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
const writer = SessionID.make("ses_compactor")

afterEach(async () => {
  await Promise.all(cleanup.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })))
})

async function fixture() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "memory-compaction-"))
  cleanup.push(dir)
  const sessionLayer = Layer.mock(Session.Service)({
    get: (sessionID) => Effect.succeed({ id: sessionID, parentID: undefined } as Session.Info),
    messages: () => Effect.succeed([]),
  })
  const layer = Memory.layerWithDirectory(dir).pipe(
    Layer.provide(Layer.merge(AppFileSystem.defaultLayer, sessionLayer)),
  )
  const run = <A, E>(effect: Effect.Effect<A, E, Memory.Service>) =>
    Effect.runPromise(effect.pipe(Effect.provide(layer)))
  const target = (scope: Memory.Scope) => path.join(dir, scope === "memory" ? "MEMORY.json" : "USER.json")
  const seed = async (scope: Memory.Scope, entries: Memory.MemoryEntry[]) => {
    await fs.writeFile(target(scope), Memory.serializeStore(scope, entries), "utf8")
  }
  const read = async (scope: Memory.Scope) => {
    const text = await fs.readFile(target(scope), "utf8")
    const entries = Memory.parseStore(scope, text).entries
    return { text, entries }
  }
  return { run, seed, read }
}

function task(input: {
  id: string
  importance?: Memory.Importance
  date?: string
  keywords?: string[]
  content?: string
}): Memory.TaskMemoryEntry {
  return {
    scope: "memory",
    importance: input.importance ?? 5,
    date: input.date ?? "20260705",
    keywords: input.keywords ?? ["项目"],
    content: input.content ?? `完成项目 ${input.id}。`,
    sessionID: SessionID.make(input.id),
  }
}

function user(
  index: number,
  importance: Memory.Importance,
  content = `用户稳定事实 ${index}。`,
): Memory.UserMemoryEntry {
  return { scope: "user", importance, keywords: [`事实${index}`], content }
}

describe("bounded deterministic memory compaction", () => {
  test("merges entries with similar keywords", async () => {
    const { run, seed, read } = await fixture()
    const entries = [
      task({ id: "ses_racing_a", date: "20260701", content: "完成赛车游戏基础建模。", keywords: ["赛车", "地图"] }),
      task({ id: "ses_racing_b", date: "20260705", content: "完成赛车游戏地图优化。", keywords: ["赛车", "地图"] }),
      task({ id: "ses_similar_a", content: "完成代码质量检查。", keywords: ["ts", "代码"] }),
      task({ id: "ses_similar_b", content: "完成代码性能优化。", keywords: ["ts", "代码", "优化"] }),
      task({ id: "ses_document", content: "完成独立文档。", keywords: ["文档"] }),
    ]
    await seed("memory", entries)

    const result = await run(Memory.Service.use((memory) => memory.compact({ sessionID: writer, scope: "memory" })))
    const stored = await read("memory")

    expect(result.merged).toBeGreaterThanOrEqual(2)
    expect(result.retained).toBe(stored.entries.length)
    expect(
      (stored.entries as Memory.TaskMemoryEntry[]).filter((entry) => entry.keywords.includes("赛车")),
    ).toHaveLength(1)
  })

  test("consolidates low-value entries, protects high-value user facts, and returns below 70 percent", async () => {
    const { run, seed, read } = await fixture()
    const long = "长期稳定信息".repeat(30)
    await seed("user", [
      user(0, 10, `用户姓名为金毅阳。${long}`),
      ...Array.from({ length: 24 }, (_, i) => user(i + 1, 2, long)),
    ])

    const result = await run(Memory.Service.use((memory) => memory.compact({ sessionID: writer, scope: "user" })))
    const stored = await read("user")

    expect(result.removed + result.merged).toBeGreaterThan(0)
    expect(result.after.percentage).toBeLessThanOrEqual(70)
    expect(result.after.entries).toBeLessThanOrEqual(45)
    expect(stored.text.length).toBeLessThanOrEqual(2_000)
    expect(stored.entries.some((entry) => entry.importance === 10 && entry.keywords.includes("事实0"))).toBe(true)
  })

  test("automatically compacts when the projected entry count reaches 51", async () => {
    const { run, seed, read } = await fixture()
    await seed(
      "memory",
      Array.from({ length: 50 }, (_, i) => task({ id: `ses_${i}`, importance: 3 })),
    )

    await run(
      Memory.Service.use((memory) =>
        memory.upsertTaskMemory({
          sessionID: SessionID.make("ses_50"),
          importance: 8,
          keywords: ["最新项目"],
          content: "用户要求交付项目，我用了容量压缩，最终学会了保留高价值条目",
        }),
      ),
    )
    const stored = await read("memory")

    expect(stored.entries.length).toBeLessThanOrEqual(45)
    expect(stored.text.length).toBeLessThanOrEqual(10_000)
    expect((stored.entries as Memory.TaskMemoryEntry[]).some((entry) => entry.sessionID === "ses_50")).toBe(true)
  })

  test("rejects a low-value candidate when protected entries leave no capacity", async () => {
    const { run, seed, read } = await fixture()
    const protectedEntries = Array.from({ length: 10 }, (_, i) => user(i, 10, `用户关键身份事实 ${i}。`))
    await seed("user", protectedEntries)
    const before = await read("user")

    const result = await run(
      Memory.Service.use((memory) =>
        memory.upsertUserMemory({
          sessionID: writer,
          importance: 2,
          keywords: ["低价值"],
          content: `一次性候选：${"乙".repeat(800)}。`,
        }),
      ),
    )
    const after = await read("user")

    expect(result.status).toBe("capacity_rejected")
    expect(after.text.length).toBeLessThanOrEqual(2_000)
    expect(after.entries.some((entry) => entry.keywords.includes("低价值候选"))).toBe(false)
    expect(after.entries.length).toBe(before.entries.length)
  })
})
