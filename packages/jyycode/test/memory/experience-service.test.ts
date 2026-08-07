import { afterEach, describe, expect, test } from "bun:test"
import fs from "fs/promises"
import os from "os"
import path from "path"
import { AppFileSystem } from "@jyycode-ai/core/filesystem"
import { Effect, Layer } from "effect"
import { ExperienceMemory } from "@/memory/experience"
import { SessionID } from "@/session/schema"

const cleanup: string[] = []
const sessionID = SessionID.make("ses_experience")

afterEach(async () => {
  await Promise.all(cleanup.splice(0).map((directory) => fs.rm(directory, { recursive: true, force: true })))
})

function candidate(overrides: Partial<ExperienceMemory.ExperienceCandidate> = {}): ExperienceMemory.ExperienceCandidate {
  return {
    kind: "failure",
    importance: 8,
    keywords: ["ssh"],
    content: "SSH 权限报错时先检查密钥权限再重试",
    evidence: "[ses_experience#1] ssh -T git@github.com",
    confidence: "high",
    ...overrides,
  }
}

async function withStore<T>(run: (service: ExperienceMemory.Service) => Promise<T>): Promise<T> {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "experience-"))
  cleanup.push(directory)
  const layer = ExperienceMemory.layerWithDirectory(directory).pipe(Layer.provide(AppFileSystem.defaultLayer))
  return Effect.runPromise(ExperienceMemory.Service.use((service) => Effect.promise(() => run(service))).pipe(Effect.provide(layer)))
}

describe("experience service", () => {
  test("writes then reports an exact duplicate", async () => {
    await withStore(async (service) => {
      const first = await Effect.runPromise(service.upsert(sessionID, candidate()))
      const second = await Effect.runPromise(service.upsert(sessionID, candidate()))
      expect(first.status).toBe("written")
      expect(second.status).toBe("duplicate")
      expect((await Effect.runPromise(service.readStore(sessionID))).entries).toHaveLength(1)
    })
  })

  test("merges same-session same-kind lessons but keeps cross-session ones", async () => {
    await withStore(async (service) => {
      const other = SessionID.make("ses_experience_other")
      const first = await Effect.runPromise(
        service.upsert(sessionID, candidate({ content: "SSH 权限报错时先检查密钥权限", evidence: "[ses_experience#1] ssh" })),
      )
      const second = await Effect.runPromise(
        service.upsert(sessionID, candidate({ content: "SSH 权限报错时先检查密钥权限再重试", evidence: "[ses_experience#2] ssh -T" })),
      )
      const cross = await Effect.runPromise(service.upsert(other, candidate()))
      expect(first.status).toBe("written")
      expect(second.status).toBe("merged")
      expect(cross.status).toBe("written")
      const store = await Effect.runPromise(service.readStore(sessionID))
      expect(store.entries).toHaveLength(2)
    })
  })

  test("supersedes an opposite outcome on the same keyword cluster", async () => {
    await withStore(async (service) => {
      await Effect.runPromise(service.upsert(sessionID, candidate({ kind: "success", content: "SSH 直接重试有效" })))
      const result = await Effect.runPromise(service.upsert(sessionID, candidate()))
      expect(result.status).toBe("superseded")
      const store = await Effect.runPromise(service.readStore(sessionID))
      expect(store.entries.filter((entry) => entry.status === "active")).toHaveLength(1)
      expect(store.entries.filter((entry) => entry.status === "superseded")).toHaveLength(1)
    })
  })

  test("search returns active hits and increments uses", async () => {
    await withStore(async (service) => {
      await Effect.runPromise(service.upsert(sessionID, candidate()))
      const hits = await Effect.runPromise(service.search({ sessionID, query: "ssh 权限" }))
      expect(hits).toHaveLength(1)
      expect(hits[0]?.uses).toBe(1)
      const persisted = (await Effect.runPromise(service.readStore(sessionID))).entries[0]
      expect(persisted?.uses).toBe(1)
    })
  })

  test("snapshot includes only keyword-matched experiences within budget", async () => {
    await withStore(async (service) => {
      await Effect.runPromise(service.upsert(sessionID, candidate()))
      await Effect.runPromise(service.upsert(sessionID, candidate({ kind: "lesson", keywords: ["部署"], content: "部署前先跑测试" })))
      const matched = await Effect.runPromise(service.formatExperienceSnapshot(sessionID, ["ssh"]))
      expect(matched).toContain("SSH")
      expect(matched).not.toContain("部署前先跑测试")
      const unmatched = await Effect.runPromise(service.formatExperienceSnapshot(sessionID, ["无关"]))
      expect(unmatched).toBe("")
    })
  })

  test("rejects evidence without a [sessionID#turn] anchor", async () => {
    await withStore(async (service) => {
      await expect(
        Effect.runPromise(service.upsert(sessionID, candidate({ evidence: "no anchor" }))),
      ).rejects.toThrow("evidence")
    })
  })
})

describe("experience maintenance", () => {
  async function seedStore(directory: string, entries: ExperienceMemory.ExperienceEntry[]) {
    await fs.writeFile(
      path.join(directory, "EXPERIENCE.json"),
      ExperienceMemory.serializeExperienceStore(entries, ExperienceMemory.localDate()),
    )
  }

  test("drops superseded entries older than 30 days but keeps recent ones", async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "experience-maint-"))
    cleanup.push(directory)
    const layer = ExperienceMemory.layerWithDirectory(directory).pipe(Layer.provide(AppFileSystem.defaultLayer))
    const run = (effect: Effect.Effect<unknown, unknown, ExperienceMemory.Service>) =>
      Effect.runPromise(Effect.provide(effect, layer))
    await seedStore(directory, [
      {
        scope: "experience",
        kind: "success",
        importance: 8,
        date: ExperienceMemory.dateNDaysAgo(31),
        updatedAt: ExperienceMemory.dateNDaysAgo(31),
        keywords: ["旧经验"],
        content: "旧的成功经验",
        evidence: "[ses_experience#1] old",
        confidence: "high",
        uses: 0,
        status: "superseded",
        sessionID,
      },
      {
        scope: "experience",
        kind: "lesson",
        importance: 7,
        date: ExperienceMemory.dateNDaysAgo(1),
        updatedAt: ExperienceMemory.dateNDaysAgo(1),
        keywords: ["部署"],
        content: "部署前先跑测试",
        evidence: "[ses_experience#2] deploy",
        confidence: "medium",
        uses: 1,
        status: "superseded",
        sessionID,
      },
    ])
    const result = await run(
      ExperienceMemory.Service.use((service) => service.maintain(sessionID)),
    )
    expect(result).toMatchObject({ removed: 1, merged: 0, retained: 1 })
    const store = await run(ExperienceMemory.Service.use((service) => service.readStore(sessionID)))
    expect(store.entries.map((entry) => entry.content)).toEqual(["部署前先跑测试"])
  })

  test("removes low-confidence unused experiences older than 30 days", async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "experience-decay-"))
    cleanup.push(directory)
    const layer = ExperienceMemory.layerWithDirectory(directory).pipe(Layer.provide(AppFileSystem.defaultLayer))
    const run = (effect: Effect.Effect<unknown, unknown, ExperienceMemory.Service>) =>
      Effect.runPromise(Effect.provide(effect, layer))
    await seedStore(directory, [
      {
        scope: "experience",
        kind: "lesson",
        importance: 4,
        date: ExperienceMemory.dateNDaysAgo(31),
        updatedAt: ExperienceMemory.dateNDaysAgo(31),
        keywords: ["猜测"],
        content: "低置信且从未用过的经验",
        evidence: "[ses_experience#1] guess",
        confidence: "low",
        uses: 0,
        status: "active",
        sessionID,
      },
      {
        scope: "experience",
        kind: "lesson",
        importance: 6,
        date: ExperienceMemory.dateNDaysAgo(31),
        updatedAt: ExperienceMemory.dateNDaysAgo(31),
        keywords: ["使用"],
        content: "低置信但被复用过的经验",
        evidence: "[ses_experience#2] used",
        confidence: "low",
        uses: 3,
        status: "active",
        sessionID,
      },
    ])
    const result = await run(
      ExperienceMemory.Service.use((service) => service.maintain(sessionID)),
    )
    expect(result).toMatchObject({ removed: 1 })
    const store = await run(ExperienceMemory.Service.use((service) => service.readStore(sessionID)))
    expect(store.entries.map((entry) => entry.content)).toEqual(["低置信但被复用过的经验"])
  })

  test("evicts low-value entries at capacity and keeps the new candidate", async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "experience-cap-"))
    cleanup.push(directory)
    const layer = ExperienceMemory.layerWithDirectory(directory).pipe(Layer.provide(AppFileSystem.defaultLayer))
    const run = (effect: Effect.Effect<unknown, unknown, ExperienceMemory.Service>) =>
      Effect.runPromise(Effect.provide(effect, layer))
    const entries: ExperienceMemory.ExperienceEntry[] = Array.from({ length: 100 }, (_, index) => ({
      scope: "experience" as const,
      kind: "lesson" as const,
      importance: (index === 0 ? 10 : 2) as ExperienceMemory.ExperienceEntry["importance"],
      date: "20260807",
      updatedAt: "20260807",
      keywords: [`旧${index}`],
      content: `旧的低价值经验 ${index}`,
      evidence: `[ses_experience#${index + 1}] seed`,
      confidence: "low" as const,
      uses: 0,
      status: "active" as const,
      sessionID,
    }))
    await seedStore(directory, entries)
    const result = await run(
      ExperienceMemory.Service.use((service) =>
        service.upsert(sessionID, {
          kind: "failure",
          importance: 9,
          keywords: ["关键"],
          content: "关键的新失败经验",
          evidence: "[ses_experience#101] critical",
          confidence: "high",
        }),
      ),
    )
    expect(result.status).toBe("written")
    const store = await run(ExperienceMemory.Service.use((service) => service.readStore(sessionID)))
    expect(store.entries.length).toBeLessThanOrEqual(100)
    expect(store.entries.some((entry) => entry.content === "关键的新失败经验")).toBe(true)
    expect(store.entries.some((entry) => entry.content === "旧的低价值经验 0")).toBe(true)
    expect(store.entries.filter((entry) => entry.content === "旧的低价值经验 1")).toHaveLength(0)
  })
})
