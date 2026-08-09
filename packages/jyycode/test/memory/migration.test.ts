import { afterEach, describe, expect, test } from "bun:test"
import fs from "fs/promises"
import os from "os"
import path from "path"
import { AppFileSystem } from "@jyycode-ai/core/filesystem"
import { Effect, Layer } from "effect"
import { ExperienceMemory } from "@/memory/experience"
import { Memory } from "@/memory/memory"
import { sanitizeForPersistence } from "@/memory/sanitize"
import { Session } from "@/session/session"
import { SessionID } from "@/session/schema"

const cleanup: string[] = []
const sessionID = SessionID.make("ses_migration")

afterEach(async () => {
  await Promise.all(cleanup.splice(0).map((directory) => fs.rm(directory, { recursive: true, force: true })))
})

function sessionLayer() {
  return Layer.mock(Session.Service)({
    get: (id) => Effect.succeed({ id, parentID: undefined, projectID: "project-migration" } as Session.Info),
    messages: () => Effect.succeed([]),
  })
}

describe("persistent memory migration and isolation", () => {
  test("copies an explicitly selected source and preserves it", async () => {
    const source = await fs.mkdtemp(path.join(os.tmpdir(), "memory-source-"))
    const target = await fs.mkdtemp(path.join(os.tmpdir(), "memory-target-"))
    cleanup.push(source, target)
    const sourceText = Memory.serializeStore("user", [
      { scope: "user", importance: 7, keywords: ["迁移"], content: "显式迁移的用户事实" },
    ])
    await fs.writeFile(path.join(source, "USER.json"), sourceText, "utf8")

    const layer = Memory.layerWithDirectory(target).pipe(
      Layer.provide(Layer.merge(AppFileSystem.defaultLayer, sessionLayer())),
    )
    const result = await Effect.runPromise(
      Memory.Service.use((memory) => {
        if (!memory.migrateFromDirectory) throw new Error("migration API unavailable")
        return memory.migrateFromDirectory({ sessionID, sourceDirectory: source })
      }).pipe(Effect.provide(layer)),
    )

    expect(result.sourcePreserved).toBe(true)
    expect(result.scopes).toEqual(["user"])
    expect(await fs.readFile(path.join(source, "USER.json"), "utf8")).toBe(sourceText)
    expect(await fs.readFile(path.join(target, "USER.json"), "utf8")).toBe(sourceText)
  })

  test("keeps a malformed source intact when explicit migration fails", async () => {
    const source = await fs.mkdtemp(path.join(os.tmpdir(), "memory-bad-source-"))
    const target = await fs.mkdtemp(path.join(os.tmpdir(), "memory-bad-target-"))
    cleanup.push(source, target)
    const malformed = '{"schemaVersion":3,"entries": [}'
    await fs.writeFile(path.join(source, "USER.json"), malformed, "utf8")

    const layer = Memory.layerWithDirectory(target).pipe(
      Layer.provide(Layer.merge(AppFileSystem.defaultLayer, sessionLayer())),
    )
    await expect(
      Effect.runPromise(
        Memory.Service.use((memory) => {
          if (!memory.migrateFromDirectory) throw new Error("migration API unavailable")
          return memory.migrateFromDirectory({ sessionID, sourceDirectory: source })
        }).pipe(Effect.provide(layer)),
      ),
    ).rejects.toThrow()
    expect(await fs.readFile(path.join(source, "USER.json"), "utf8")).toBe(malformed)
  })

  test("isolates automatic experience search by workspace root", async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "experience-scope-"))
    cleanup.push(directory)
    const layer = ExperienceMemory.layerWithDirectory(directory).pipe(Layer.provide(AppFileSystem.defaultLayer))
    const result = await Effect.runPromise(
      ExperienceMemory.Service.use((experience) =>
        Effect.gen(function* () {
          yield* experience.upsert(
            sessionID,
            {
              kind: "lesson",
              importance: 8,
              keywords: ["proj"],
              content: "Project A requires its own validation",
              evidence: "[ses_migration#1] project-a",
              confidence: "high",
            },
            "C:/workspace/project-a",
          )
          const a = yield* experience.search({
            sessionID,
            query: "proj",
            workspaceRoot: "C:/workspace/project-a",
          })
          const b = yield* experience.search({
            sessionID,
            query: "proj",
            workspaceRoot: "C:/workspace/project-b",
          })
          return { a, b }
        }),
      ).pipe(Effect.provide(layer)),
    )
    expect(result.a).toHaveLength(1)
    expect(result.b).toHaveLength(0)
  })

  test("redacts credentials without retaining their source text", () => {
    const raw = "Authorization: Bearer super-secret-token-value api_key=sk-12345678901234567890"
    const sanitized = sanitizeForPersistence(raw)
    expect(sanitized.redacted).toBeGreaterThan(0)
    expect(sanitized.text).not.toContain("super-secret-token-value")
    expect(sanitized.text).not.toContain("sk-12345678901234567890")
    expect(sanitized.text).toContain("[REDACTED]")
  })
})
