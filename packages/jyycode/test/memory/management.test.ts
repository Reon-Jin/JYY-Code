import { afterEach, describe, expect, test } from "bun:test"
import fs from "fs/promises"
import os from "os"
import path from "path"
import { AppFileSystem } from "@jyycode-ai/core/filesystem"
import { Effect, Exit, Layer } from "effect"
import { Memory } from "@/memory/memory"
import { MemoryManagement } from "@/memory/management"
import { Session } from "@/session/session"
import { SessionID } from "@/session/schema"

const cleanup: string[] = []

afterEach(async () => {
  await Promise.all(cleanup.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })))
})

async function fixture(input?: { legacy?: boolean }) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "memory-management-"))
  cleanup.push(directory)
  const legacyDirectory = input?.legacy ? await fs.mkdtemp(path.join(os.tmpdir(), "memory-management-legacy-")) : undefined
  if (legacyDirectory) cleanup.push(legacyDirectory)
  const child = SessionID.make("ses_child")
  const sessionLayer = Layer.mock(Session.Service)({
    get: (sessionID) => Effect.succeed({ id: sessionID, parentID: sessionID === child ? "ses_parent" : undefined } as Session.Info),
    messages: () => Effect.succeed([]),
  })
  const memoryLayer = Memory.layerWithDirectory(directory, { legacyDirectory }).pipe(
    Layer.provide(Layer.merge(AppFileSystem.defaultLayer, sessionLayer)),
  )
  const layer = MemoryManagement.layer.pipe(Layer.provide(memoryLayer))
  const run = <A, E>(effect: Effect.Effect<A, E, MemoryManagement.Service | Memory.Service>) =>
    Effect.runPromise(effect.pipe(Effect.provide(Layer.merge(layer, memoryLayer))))
  return { directory, legacyDirectory, child, run }
}

describe("audited memory management storage", () => {
  test("lists user and task entries with opaque ids and no filesystem paths", async () => {
    const ctx = await fixture()
    await ctx.run(
      MemoryManagement.Service.use((management) =>
        Effect.gen(function* () {
          yield* management.createUser({ importance: 7, keywords: ["偏好"], content: "用户偏好深色界面。" })
          yield* management.update({
            scope: "task",
            id: null,
            sessionID: SessionID.make("ses_task"),
            importance: 6,
            keywords: ["任务"],
            content: "用户要求完成设置，我完成了设置实现。",
          })
        }),
      ),
    )

    const user = await ctx.run(MemoryManagement.Service.use((management) => management.list({ scope: "user" })))
    const task = await ctx.run(
      MemoryManagement.Service.use((management) => management.list({ scope: "task", sessionID: SessionID.make("ses_task") })),
    )
    expect(user.entries[0]).toMatchObject({ scope: "user", keywords: ["偏好"], content: "用户偏好深色界面。" })
    expect(user.entries[0]?.id).toMatch(/^usr_[A-Za-z0-9_-]+$/)
    expect(task.entries[0]).toMatchObject({ scope: "task", sessionID: "ses_task" })
    expect(task.entries[0]?.id).toMatch(/^tsk_[A-Za-z0-9_-]+$/)
    expect(JSON.stringify({ user, task })).not.toContain(ctx.directory)
  })

  test("updates and deletes only the exact id and compacts under the shared atomic lock", async () => {
    const ctx = await fixture()
    const created = await ctx.run(
      MemoryManagement.Service.use((management) =>
        management.createUser({ importance: 4, keywords: ["主题"], content: "用户喜欢深色主题。" }),
      ),
    )
    const updated = await ctx.run(
      MemoryManagement.Service.use((management) =>
        management.update({ ...created, importance: 8, keywords: ["配色"], content: "用户喜欢高对比配色。" }),
      ),
    )
    expect(updated.id).not.toBe(created.id)
    await ctx.run(MemoryManagement.Service.use((management) => management.compact({ scope: "user" })))
    await ctx.run(MemoryManagement.Service.use((management) => management.remove({ scope: "user", id: updated.id })))
    const page = await ctx.run(MemoryManagement.Service.use((management) => management.list({ scope: "user" })))
    expect(page.entries).toEqual([])
    expect((await fs.readdir(ctx.directory)).filter((name) => name.includes(".tmp"))).toEqual([])
  })

  test("rejects sensitive content, invalid keywords, cross-scope ids, stale task ids, and capacity overflow", async () => {
    const ctx = await fixture()
    const management = MemoryManagement.Service
    const sensitive = await ctx.run(
      Effect.exit(management.use((service) => service.createUser({ importance: 5, keywords: ["密钥"], content: "api_key=sk-secret" }))),
    )
    const invalid = await ctx.run(
      Effect.exit(management.use((service) => service.createUser({ importance: 5, keywords: ["x"], content: "用户偏好。" }))),
    )
    const user = await ctx.run(
      management.use((service) => service.createUser({ importance: 5, keywords: ["偏好"], content: "用户偏好中文。" })),
    )
    const crossScope = await ctx.run(
      Effect.exit(management.use((service) => service.remove({ scope: "task", id: user.id, sessionID: SessionID.make("ses_task") }))),
    )
    const task = await ctx.run(
      management.use((service) =>
        service.update({ scope: "task", id: null, sessionID: SessionID.make("ses_task"), importance: 5, keywords: ["任务"], content: "用户要求实现任务，我完成了任务。" }),
      ),
    )
    await ctx.run(management.use((service) => service.update({ ...task, content: "用户要求更新任务，我完成了更新。" })))
    if (task.scope !== "task") throw new Error("Expected task memory")
    const stale = await ctx.run(Effect.exit(management.use((service) => service.remove({ scope: "task", id: task.id, sessionID: task.sessionID }))))
    const overflow = await ctx.run(
      Effect.exit(management.use((service) => service.createUser({ importance: 5, keywords: ["超限"], content: "很".repeat(2_100) }))),
    )

    expect(Exit.isFailure(sensitive)).toBe(true)
    expect(Exit.isFailure(invalid)).toBe(true)
    expect(Exit.isFailure(crossScope)).toBe(true)
    expect(Exit.isFailure(stale)).toBe(true)
    expect(Exit.isFailure(overflow)).toBe(true)
  })

  test("exports parseable stores, preserves primary/subagent restrictions, and audits desktop writes", async () => {
    const ctx = await fixture()
    await ctx.run(
      MemoryManagement.Service.use((management) =>
        management.createUser({ importance: 9, keywords: ["语言"], content: "用户偏好简体中文。" }),
      ),
    )
    const exported = await ctx.run(
      MemoryManagement.Service.use((management) => management.exportStore({ scope: "user" })),
    )
    expect(Memory.parseStore("user", exported).entries).toHaveLength(1)

    const childWrite = await ctx.run(
      Effect.exit(
        Memory.Service.use((memory) =>
          memory.upsertUserMemory({ sessionID: ctx.child, importance: 5, keywords: ["越权"], content: "子智能体不应写入。" }),
        ),
      ),
    )
    expect(Exit.isFailure(childWrite)).toBe(true)
    expect(await fs.readFile(path.join(ctx.directory, "audit.jsonl"), "utf8")).toContain('"writerKind":"desktop-management"')
  })

  test("migrates a valid legacy store idempotently without deleting the source", async () => {
    const ctx = await fixture({ legacy: true })
    const source = path.join(ctx.legacyDirectory!, "USER.json")
    const text = Memory.serializeStore("user", [
      { scope: "user", importance: 6, keywords: ["迁移"], content: "用户需要迁移记忆。" },
    ])
    await fs.writeFile(source, text, "utf8")
    await ctx.run(MemoryManagement.Service.use((management) => management.list({ scope: "user" })))
    await ctx.run(MemoryManagement.Service.use((management) => management.list({ scope: "user" })))
    expect(await fs.readFile(path.join(ctx.directory, "USER.json"), "utf8")).toBe(text)
    expect(await fs.readFile(source, "utf8")).toBe(text)
  })
})
