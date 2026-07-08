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
const sessionID = SessionID.make("ses_search")

afterEach(async () => {
  await Promise.all(cleanup.splice(0).map((directory) => fs.rm(directory, { recursive: true, force: true })))
})

async function fixture() {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "memory-search-"))
  cleanup.push(directory)
  await fs.writeFile(
    path.join(directory, "MEMORY.json"),
    Memory.serializeStore("memory", [
      {
        scope: "memory",
        sessionID,
        importance: 7,
        date: "20260705",
        keywords: ["ts", "架构"],
        content: "项目采用 TypeScript 分层架构。",
      },
      {
        scope: "memory",
        sessionID: SessionID.make("ses_other"),
        importance: 4,
        date: "20260704",
        keywords: ["部署"],
        content: "部署使用本地脚本。",
      },
    ]),
  )
  await fs.writeFile(
    path.join(directory, "USER.json"),
    Memory.serializeStore("user", [
      { scope: "user", importance: 9, keywords: ["沟通偏好"], content: "用户偏好中文简洁回答。" },
    ]),
  )
  const sessions = Layer.mock(Session.Service)({
    get: (id) => Effect.succeed({ id, parentID: undefined } as Session.Info),
    messages: () => Effect.succeed([]),
  })
  const layer = Memory.layerWithDirectory(directory).pipe(
    Layer.provide(Layer.merge(AppFileSystem.defaultLayer, sessions)),
  )
  const run = <A, E>(effect: Effect.Effect<A, E, Memory.Service>) =>
    Effect.runPromise(effect.pipe(Effect.provide(layer)))
  return { run }
}

describe("JSON memory search", () => {
  test("searches complete entries across both stores", async () => {
    const { run } = await fixture()
    const results = await run(
      Memory.Service.use((memory) =>
        memory.search({ sessionID, scope: "all", query: "typescript 中文", limit: 5 }),
      ),
    )

    expect(results).toHaveLength(2)
    expect(results[0]?.text).toContain("importance=")
    expect(results[0]?.text).toContain("content=")
    expect(results.map((result) => path.basename(result.file)).sort()).toEqual(["MEMORY.json", "USER.json"])
  })

  test("honors scope routing", async () => {
    const { run } = await fixture()
    const results = await run(
      Memory.Service.use((memory) => memory.search({ sessionID, scope: "user", query: "中文" })),
    )

    expect(results).toHaveLength(1)
    expect(results[0]?.section).toBe("user")
    expect(results[0]?.text).toContain("用户偏好中文简洁回答。")
  })
})
