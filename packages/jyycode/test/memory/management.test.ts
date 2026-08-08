import { afterEach, describe, expect, test } from "bun:test"
import fs from "fs/promises"
import os from "os"
import path from "path"
import { AppFileSystem } from "@jyycode-ai/core/filesystem"
import { Effect, Exit, Layer } from "effect"
import { Memory } from "@/memory/memory"
import { MemoryManagement } from "@/memory/management"
import { ExperienceMemory } from "@/memory/experience"
import { Session } from "@/session/session"
import { SessionID } from "@/session/schema"

const cleanup: string[] = []

afterEach(async () => {
  await Promise.all(cleanup.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })))
})

async function fixture(input?: { legacy?: boolean }) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "memory-management-"))
  cleanup.push(directory)
  const legacyDirectory = input?.legacy
    ? await fs.mkdtemp(path.join(os.tmpdir(), "memory-management-legacy-"))
    : undefined
  if (legacyDirectory) cleanup.push(legacyDirectory)
  const child = SessionID.make("ses_child")
  const sessionLayer = Layer.mock(Session.Service)({
    get: (sessionID) =>
      Effect.succeed({
        id: sessionID,
        parentID: sessionID === child ? "ses_parent" : undefined,
        projectID: (sessionID.startsWith("ses_p1")
          ? "proj_one"
          : sessionID.startsWith("ses_p2")
            ? "proj_two"
            : `proj_${sessionID}`) as Session.Info["projectID"],
      } as Session.Info),
    messages: () => Effect.succeed([]),
  })
  const memoryLayer = Memory.layerWithDirectory(directory, { legacyDirectory }).pipe(
    Layer.provide(Layer.merge(AppFileSystem.defaultLayer, sessionLayer)),
  )
  const experienceLayer = ExperienceMemory.layerWithDirectory(directory).pipe(Layer.provide(AppFileSystem.defaultLayer))
  const layer = MemoryManagement.layer.pipe(Layer.provide(memoryLayer), Layer.provide(experienceLayer))
  const run = <A, E>(
    effect: Effect.Effect<A, E, MemoryManagement.Service | Memory.Service | ExperienceMemory.Service>,
  ) =>
    Effect.runPromise(
      effect.pipe(Effect.provide(Layer.merge(Layer.merge(layer, memoryLayer), experienceLayer))),
    )
  return { directory, legacyDirectory, child, run }
}

describe("audited memory management storage", () => {
  test("repairs blank stores before listing memories", async () => {
    const ctx = await fixture()
    await fs.writeFile(path.join(ctx.directory, "MEMORY.json"), "\n", "utf8")
    await fs.writeFile(path.join(ctx.directory, "USER.json"), "", "utf8")

    const page = await ctx.run(MemoryManagement.Service.use((management) => management.list({ scope: "user" })))

    expect(page).toEqual({ entries: [], total: 0 })
    expect(JSON.parse(await fs.readFile(path.join(ctx.directory, "USER.json"), "utf8"))).toEqual({
      schemaVersion: 3,
      lastCompactedAt: null,
      entries: [],
    })
  })

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
            content: "当前任务：完成设置；进展：完成分步配置",
          })
        }),
      ),
    )

    const user = await ctx.run(MemoryManagement.Service.use((management) => management.list({ scope: "user" })))
    const task = await ctx.run(
      MemoryManagement.Service.use((management) =>
        management.list({ scope: "task", sessionID: SessionID.make("ses_task") }),
      ),
    )
    expect(user.entries[0]).toMatchObject({ scope: "user", keywords: ["偏好"], content: "用户偏好深色界面。" })
    expect(user.entries[0]?.id).toMatch(/^usr_[A-Za-z0-9_-]+$/)
    expect(task.entries[0]).toMatchObject({ scope: "task", sessionID: "ses_task" })
    expect(task.entries[0]?.id).toMatch(/^tsk_[A-Za-z0-9_-]+$/)
    expect(JSON.stringify({ user, task })).not.toContain(ctx.directory)
  })

  test("dates new user memories and lists dated entries from newest to oldest", async () => {
    const ctx = await fixture()
    const created = await ctx.run(
      MemoryManagement.Service.use((management) =>
        management.createUser({ importance: 7, keywords: ["prof"], content: "User prefers compact layouts" }),
      ),
    )
    expect(created.date).toMatch(/^\d{8}$/)

    await fs.writeFile(
      path.join(ctx.directory, "MEMORY.json"),
      Memory.serializeStore("memory", [
        {
          scope: "memory",
          sessionID: SessionID.make("ses_old"),
          importance: 5,
          date: "20260701",
          keywords: ["old"],
          content: "Old task",
        },
        {
          scope: "memory",
          sessionID: SessionID.make("ses_new"),
          importance: 5,
          date: "20260718",
          keywords: ["new"],
          content: "New task",
        },
      ]),
      "utf8",
    )

    const page = await ctx.run(MemoryManagement.Service.use((management) => management.list({ scope: "task" })))
    expect(page.entries.map((entry) => (entry.scope === "task" ? entry.date : ""))).toEqual(["20260718", "20260701"])
  })

  test("lists and searches task memories across sessions when no session is specified", async () => {
    const ctx = await fixture()
    await ctx.run(
      MemoryManagement.Service.use((management) =>
        Effect.gen(function* () {
          yield* management.update({
            scope: "task",
            id: null,
            sessionID: SessionID.make("ses_first"),
            importance: 6,
            keywords: ["设置"],
            content: "当前任务：完成设置；进展：完成分步配置",
          })
          yield* management.update({
            scope: "task",
            id: null,
            sessionID: SessionID.make("ses_second"),
            importance: 7,
            keywords: ["附件"],
            content: "当前任务：支持附件；进展：完成分块上传",
          })
        }),
      ),
    )

    const all = await ctx.run(MemoryManagement.Service.use((management) => management.list({ scope: "task" })))
    const searched = await ctx.run(
      MemoryManagement.Service.use((management) => management.list({ scope: "task", query: "附件" })),
    )
    expect(all.entries.map((entry) => (entry.scope === "task" ? String(entry.sessionID) : ""))).toEqual([
      "ses_second",
      "ses_first",
    ])
    expect(searched.entries).toHaveLength(1)
    expect(searched.entries[0]).toMatchObject({ scope: "task", sessionID: "ses_second", keywords: ["附件"] })
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
      Effect.exit(
        management.use((service) =>
          service.createUser({ importance: 5, keywords: ["密钥"], content: "api_key=sk-secret" }),
        ),
      ),
    )
    const invalid = await ctx.run(
      Effect.exit(
        management.use((service) => service.createUser({ importance: 5, keywords: ["x"], content: "用户偏好。" })),
      ),
    )
    const user = await ctx.run(
      management.use((service) => service.createUser({ importance: 5, keywords: ["偏好"], content: "用户偏好中文。" })),
    )
    const crossScope = await ctx.run(
      Effect.exit(
        management.use((service) =>
          service.remove({ scope: "task", id: user.id, sessionID: SessionID.make("ses_task") }),
        ),
      ),
    )
    const task = await ctx.run(
      management.use((service) =>
        service.update({
          scope: "task",
          id: null,
          sessionID: SessionID.make("ses_task"),
          importance: 5,
          keywords: ["任务"],
          content: "当前任务：实现任务；进展：完成步骤拆解",
        }),
      ),
    )
    await ctx.run(
      management.use((service) =>
        service.update({ ...task, content: "当前任务：更新任务；进展：完成回归检查" }),
      ),
    )
    if (task.scope !== "task") throw new Error("Expected task memory")
    const stale = await ctx.run(
      Effect.exit(
        management.use((service) => service.remove({ scope: "task", id: task.id, sessionID: task.sessionID })),
      ),
    )
    const overflow = await ctx.run(
      Effect.exit(
        management.use((service) =>
          service.createUser({ importance: 5, keywords: ["超限"], content: "很".repeat(2_100) }),
        ),
      ),
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
          memory.upsertUserMemory({
            sessionID: ctx.child,
            importance: 5,
            keywords: ["越权"],
            content: "子智能体不应写入。",
          }),
        ),
      ),
    )
    expect(Exit.isFailure(childWrite)).toBe(true)
    expect(await fs.readFile(path.join(ctx.directory, "audit.jsonl"), "utf8")).toContain(
      '"writerKind":"desktop-management"',
    )
  })

  test("migrates a valid legacy store and removes the source after copying", async () => {
    const ctx = await fixture({ legacy: true })
    const source = path.join(ctx.legacyDirectory!, "USER.json")
    const text = Memory.serializeStore("user", [
      { scope: "user", importance: 6, keywords: ["迁移"], content: "用户需要迁移记忆。" },
    ])
    await fs.writeFile(source, text, "utf8")
    await ctx.run(MemoryManagement.Service.use((management) => management.list({ scope: "user" })))
    await ctx.run(MemoryManagement.Service.use((management) => management.list({ scope: "user" })))
    expect(await fs.readFile(path.join(ctx.directory, "USER.json"), "utf8")).toBe(text)
    expect(
      await fs.stat(source).then(
        () => true,
        () => false,
      ),
    ).toBe(false)
  })

  test("reflects direct JSON edits in desktop management reads", async () => {
    const ctx = await fixture()
    await ctx.run(MemoryManagement.Service.use((management) => management.list({ scope: "user" })))
    const text = Memory.serializeStore("user", [
      { scope: "user", importance: 8, keywords: ["外部编辑"], content: "用户直接编辑了本地 JSON 文件。" },
    ])
    await fs.writeFile(path.join(ctx.directory, "USER.json"), text, "utf8")

    const page = await ctx.run(MemoryManagement.Service.use((management) => management.list({ scope: "user" })))
    expect(page.entries).toHaveLength(1)
    expect(page.entries[0]).toMatchObject({ content: "用户直接编辑了本地 JSON 文件。" })
  })

  test("keeps one task entry per session and lists project siblings", async () => {
    const ctx = await fixture()
    await ctx.run(
      Memory.Service.use((memory) =>
        Effect.gen(function* () {
          yield* memory.upsertTaskMemory({
            sessionID: SessionID.make("ses_p1_a"),
            importance: 5,
            keywords: ["共享任务"],
            content: "当前任务：共享任务；进展：第一步",
          })
          yield* memory.upsertTaskMemory({
            sessionID: SessionID.make("ses_p1_b"),
            importance: 7,
            keywords: ["共享任务"],
            content: "当前任务：共享任务；进展：第二步",
          })
        }),
      ),
    )

    const page = await ctx.run(MemoryManagement.Service.use((management) => management.list({ scope: "task" })))
    expect(page.entries).toHaveLength(2)
    expect(
      page.entries.every((entry) => entry.scope === "task" && entry.projectID === "proj_one"),
    ).toBe(true)

    const scoped = await ctx.run(
      MemoryManagement.Service.use((management) =>
        management.list({ scope: "task", sessionID: SessionID.make("ses_p1_a") }),
      ),
    )
    expect(scoped.entries).toHaveLength(2)
    expect(
      (scoped.entries as MemoryManagement.TaskEntry[]).map((entry) => String(entry.sessionID)).sort(),
    ).toEqual(["ses_p1_a", "ses_p1_b"])
  })

  test("updates and deletes one session's task entry by opaque id without touching siblings", async () => {
    const ctx = await fixture()
    await ctx.run(
      Memory.Service.use((memory) =>
        Effect.gen(function* () {
          yield* memory.upsertTaskMemory({
            sessionID: SessionID.make("ses_p1_a"),
            importance: 5,
            keywords: ["共享任务"],
            content: "当前任务：共享任务；进展：第一步",
          })
          yield* memory.upsertTaskMemory({
            sessionID: SessionID.make("ses_p1_b"),
            importance: 6,
            keywords: ["共享任务"],
            content: "当前任务：共享任务；进展：第二步",
          })
        }),
      ),
    )

    const page = await ctx.run(MemoryManagement.Service.use((management) => management.list({ scope: "task" })))
    const entry = page.entries.find(
      (candidate): candidate is MemoryManagement.TaskEntry =>
        candidate.scope === "task" && candidate.sessionID === "ses_p1_a",
    )
    if (!entry) throw new Error("Expected task entry")

    const updated = await ctx.run(
      MemoryManagement.Service.use((management) =>
        management.update({
          scope: "task",
          id: entry.id,
          sessionID: SessionID.make("ses_p1_b"),
          importance: 8,
          keywords: ["共享任务"],
          content: "当前任务：共享任务；进展：已完成编辑",
        }),
      ),
    )
    expect(updated).toMatchObject({
      scope: "task",
      sessionID: "ses_p1_a",
      content: "当前任务：共享任务；进展：已完成编辑",
    })

    const scoped = await ctx.run(
      MemoryManagement.Service.use((management) =>
        management.list({ scope: "task", sessionID: SessionID.make("ses_p1_a") }),
      ),
    )
    expect(scoped.entries).toHaveLength(2)
    expect(
      scoped.entries.find(
        (candidate): candidate is MemoryManagement.TaskEntry =>
          candidate.scope === "task" && candidate.sessionID === "ses_p1_a",
      )?.content,
    ).toContain("已完成编辑")
    expect(
      scoped.entries.find(
        (candidate): candidate is MemoryManagement.TaskEntry =>
          candidate.scope === "task" && candidate.sessionID === "ses_p1_b",
      )?.content,
    ).toContain("第二步")

    await ctx.run(
      MemoryManagement.Service.use((management) =>
        management.remove({ scope: "task", id: updated.id, sessionID: SessionID.make("ses_p1_a") }),
      ),
    )
    const afterRemove = await ctx.run(MemoryManagement.Service.use((management) => management.list({ scope: "task" })))
    expect(afterRemove.entries).toHaveLength(1)
    expect((afterRemove.entries[0] as MemoryManagement.TaskEntry | undefined)?.sessionID).toBe(
      SessionID.make("ses_p1_b"),
    )
  })

  test("lists, updates, removes and exports experience memory", async () => {
    const ctx = await fixture()
    const seeded: ExperienceMemory.ExperienceEntry = {
      scope: "experience",
      kind: "failure",
      importance: 6,
      date: "20260807",
      updatedAt: "20260807",
      keywords: ["部署"],
      content: "部署脚本报错时先看日志再重试",
      evidence: "[ses_exp#1] deploy.sh",
      confidence: "high",
      uses: 0,
      status: "active",
      sessionID: SessionID.make("ses_exp"),
    }
    await fs.writeFile(
      path.join(ctx.directory, "EXPERIENCE.json"),
      ExperienceMemory.serializeExperienceStore([seeded]),
      "utf8",
    )

    const page = await ctx.run(MemoryManagement.Service.use((management) => management.list({ scope: "experience" })))
    expect(page.entries).toHaveLength(1)
    const entry = page.entries[0]
    if (entry.scope !== "experience") throw new Error("Expected experience entry")
    expect(entry.id).toMatch(/^exp_[A-Za-z0-9_-]+$/)

    const exported = await ctx.run(
      MemoryManagement.Service.use((management) => management.exportStore({ scope: "experience" })),
    )
    expect(ExperienceMemory.parseExperienceStore(exported).entries).toHaveLength(1)

    const updated = await ctx.run(
      MemoryManagement.Service.use((management) =>
        management.update({
          scope: "experience",
          id: entry.id,
          kind: "lesson",
          importance: 8,
          keywords: ["经验"],
          content: "修改经验前先检查证据锚点",
          confidence: "medium",
        }),
      ),
    )
    expect(updated).toMatchObject({ scope: "experience", kind: "lesson", content: "修改经验前先检查证据锚点" })

    await ctx.run(MemoryManagement.Service.use((management) => management.remove({ scope: "experience", id: updated.id })))
    const afterRemove = await ctx.run(
      MemoryManagement.Service.use((management) => management.list({ scope: "experience" })),
    )
    expect(afterRemove.entries).toHaveLength(0)
  })
})
