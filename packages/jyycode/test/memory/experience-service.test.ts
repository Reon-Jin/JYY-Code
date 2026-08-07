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
