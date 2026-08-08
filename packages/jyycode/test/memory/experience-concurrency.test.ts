import { afterEach, describe, expect, test } from "bun:test"
import fs from "fs/promises"
import os from "os"
import path from "path"
import { AppFileSystem } from "@jyycode-ai/core/filesystem"
import { Effect, Layer } from "effect"
import { ExperienceMemory } from "../../src/memory/experience"
import { SessionID } from "../../src/session/schema"

const directories: string[] = []

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => fs.rm(directory, { recursive: true, force: true })))
})

function candidate(
  sessionID: SessionID,
  content: string,
  overrides: Partial<ExperienceMemory.ExperienceCandidate> = {},
): ExperienceMemory.ExperienceCandidate {
  return {
    kind: "lesson",
    importance: 7,
    keywords: ["ssh"],
    content,
    evidence: `[${sessionID}#1] ssh`,
    confidence: "high",
    ...overrides,
  }
}

async function withStore<T>(run: (service: ExperienceMemory.ExperienceInterface) => Promise<T>): Promise<T> {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "experience-concurrency-"))
  directories.push(directory)
  const layer = ExperienceMemory.layerWithDirectory(directory).pipe(Layer.provide(AppFileSystem.defaultLayer))
  return Effect.runPromise(
    ExperienceMemory.Service.use((service) => Effect.promise(() => run(service))).pipe(Effect.provide(layer)),
  )
}

describe("experience service concurrency", () => {
  test("keeps same-content entries from different sessions distinct", async () => {
    await withStore(async (service) => {
      const first = SessionID.make("ses_experience_first")
      const second = SessionID.make("ses_experience_second")
      const content = "部署前先验证锁文件"

      await Effect.runPromise(service.upsert(first, candidate(first, content)))
      await Effect.runPromise(service.upsert(second, candidate(second, content)))

      const hits = await Effect.runPromise(service.search({ sessionID: first, query: "ssh", limit: 10 }))
      expect(hits.map((entry) => entry.sessionID).sort()).toEqual([first, second].sort())
      expect(new Set(hits.map((entry) => ExperienceMemory.storedExperienceKey(entry))).size).toBe(2)
    })
  })

  test("does not lose uses increments across parallel searches", async () => {
    await withStore(async (service) => {
      const sessionID = SessionID.make("ses_experience_parallel")
      await Effect.runPromise(service.upsert(sessionID, candidate(sessionID, "并发搜索必须串行更新使用次数")))

      await Promise.all(
        Array.from({ length: 10 }, () =>
          Effect.runPromise(service.search({ sessionID, query: "并发 搜索", limit: 10 })),
        ),
      )

      const store = await Effect.runPromise(service.readStore(sessionID))
      expect(store.entries).toHaveLength(1)
      expect(store.entries[0]?.uses).toBe(10)
    })
  })

  test("does not let a concurrent search overwrite a new upsert", async () => {
    await withStore(async (service) => {
      const first = SessionID.make("ses_experience_search")
      const second = SessionID.make("ses_experience_upsert")
      await Effect.runPromise(service.upsert(first, candidate(first, "搜索期间保留已有经验")))

      await Promise.all([
        Effect.runPromise(service.search({ sessionID: first, query: "ssh", limit: 10 })),
        Effect.runPromise(service.upsert(second, candidate(second, "搜索期间写入的新经验"))),
      ])

      const store = await Effect.runPromise(service.readStore(first))
      expect(store.entries.map((entry) => entry.sessionID).sort()).toEqual([first, second].sort())
    })
  })

  test("keeps exact duplicates idempotent for one session", async () => {
    await withStore(async (service) => {
      const sessionID = SessionID.make("ses_experience_duplicate")
      const input = candidate(sessionID, "同一会话的相同经验只保留一次")
      const results = await Promise.all(
        Array.from({ length: 4 }, () => Effect.runPromise(service.upsert(sessionID, input))),
      )

      expect(results.filter((result) => result.status === "written")).toHaveLength(1)
      expect(results.filter((result) => result.status === "duplicate")).toHaveLength(3)
      expect((await Effect.runPromise(service.readStore(sessionID))).entries).toHaveLength(1)
    })
  })
})
