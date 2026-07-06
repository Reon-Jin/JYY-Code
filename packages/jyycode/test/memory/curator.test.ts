import { describe, expect, test } from "bun:test"
import path from "path"
import { AppFileSystem } from "@jyycode-ai/core/filesystem"
import { Effect, Layer } from "effect"
import { Memory } from "@/memory/memory"
import { MessageV2 } from "@/session/message-v2"
import { Session } from "@/session/session"
import { MessageID, PartID, SessionID } from "@/session/schema"

const sessionID = SessionID.make("ses_curator")

function messages(userText: string, assistantText: string, suffix = "1", id = sessionID): MessageV2.WithParts[] {
  const userID = MessageID.make(`msg_user_${suffix}`)
  const assistantID = MessageID.make(`msg_assistant_${suffix}`)
  return [
    {
      info: { id: userID, sessionID: id, role: "user" } as MessageV2.User,
      parts: [{ id: PartID.make(`prt_user_${suffix}`), messageID: userID, sessionID: id, type: "text", text: userText }],
    },
    {
      info: { id: assistantID, sessionID: id, role: "assistant", parentID: userID } as MessageV2.Assistant,
      parts: [
        {
          id: PartID.make(`prt_assistant_${suffix}`),
          messageID: assistantID,
          sessionID: id,
          type: "text",
          text: assistantText,
        },
      ],
    },
  ]
}

function decision(content: string, user: Memory.MemoryDecision["user"] = []): Memory.MemoryDecision {
  return {
    shouldUpdate: true,
    reason: "durable result",
    task: { importance: 7, keywords: ["赛车游戏"], content },
    user,
  }
}

function fixture(input?: { parentID?: SessionID }) {
  const memoryPath = path.join(Memory.DIRECTORY, "MEMORY.json")
  const userPath = path.join(Memory.DIRECTORY, "USER.json")
  const files = new Map<string, string>([
    [memoryPath, Memory.serializeStore("memory", [])],
    [userPath, Memory.serializeStore("user", [])],
  ])
  let currentMessages: MessageV2.WithParts[] = []
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
          Effect.sync(() => files.set(target, typeof content === "string" ? content : new TextDecoder().decode(content))),
      })
    }),
  ).pipe(Layer.provide(AppFileSystem.defaultLayer))
  const sessionLayer = Layer.mock(Session.Service)({
    get: (id) => Effect.succeed({ id, parentID: input?.parentID } as Session.Info),
    messages: () => Effect.succeed(currentMessages),
  })
  const layer = Memory.layer.pipe(Layer.provide(Layer.merge(fsLayer, sessionLayer)))
  const run = <A, E>(effect: Effect.Effect<A, E, Memory.Service>) =>
    Effect.runPromise(effect.pipe(Effect.provide(layer)))
  return {
    files,
    memoryPath,
    userPath,
    setMessages(value: MessageV2.WithParts[]) {
      currentMessages = value
    },
    run,
  }
}

describe("post-turn memory curator", () => {
  test("forces the first valid turn to create one task memory", async () => {
    const ctx = fixture()
    ctx.setMessages(messages("请完成赛车游戏", "已完成赛车游戏基础建模。"))
    const result = await ctx.run(
      Memory.Service.use((memory) => memory.updateAfterTurn(sessionID, () => Effect.succeed(decision("完成基础建模。")))),
    )

    expect(result).toMatchObject({ status: "updated", taskUpdated: true })
    const entries = Memory.parseStore("memory", ctx.files.get(ctx.memoryPath)!).entries as Memory.TaskMemoryEntry[]
    expect(entries).toHaveLength(1)
    expect(entries[0]).toMatchObject({ sessionID, content: "完成基础建模。" })
  })

  test("uses a minimal fallback when the first evaluator call fails", async () => {
    const ctx = fixture()
    ctx.setMessages(messages("请生成部署报告", "已生成部署报告并通过检查。"))
    const result = await ctx.run(
      Memory.Service.use((memory) =>
        memory.updateAfterTurn(sessionID, () => Effect.fail(new Error("model unavailable"))),
      ),
    )

    expect(result).toMatchObject({ status: "updated", taskUpdated: true })
    const [entry] = Memory.parseStore("memory", ctx.files.get(ctx.memoryPath)!).entries
    expect(entry?.content).toContain("部署报告")
  })

  test("applies a later true decision as a session upsert", async () => {
    const ctx = fixture()
    ctx.setMessages(messages("请完成赛车游戏", "已完成基础建模。", "1"))
    await ctx.run(
      Memory.Service.use((memory) => memory.updateAfterTurn(sessionID, () => Effect.succeed(decision("完成基础建模。")))),
    )
    ctx.setMessages(messages("继续优化", "已完成碰撞性能优化。", "2"))
    await ctx.run(
      Memory.Service.use((memory) => memory.updateAfterTurn(sessionID, () => Effect.succeed(decision("完成碰撞性能优化。")))),
    )

    const entries = Memory.parseStore("memory", ctx.files.get(ctx.memoryPath)!).entries
    expect(entries).toHaveLength(1)
    expect(entries[0]?.content).toBe("完成碰撞性能优化。")
  })

  test("does not write either store for a later false decision", async () => {
    const ctx = fixture()
    ctx.setMessages(messages("请完成赛车游戏", "已完成基础建模。", "1"))
    await ctx.run(
      Memory.Service.use((memory) => memory.updateAfterTurn(sessionID, () => Effect.succeed(decision("完成基础建模。")))),
    )
    const before = { memory: ctx.files.get(ctx.memoryPath), user: ctx.files.get(ctx.userPath) }
    ctx.setMessages(messages("你好", "你好。", "2"))
    const result = await ctx.run(
      Memory.Service.use((memory) =>
        memory.updateAfterTurn(sessionID, () =>
          Effect.succeed({ shouldUpdate: false, reason: "greeting", user: [] } satisfies Memory.MemoryDecision),
        ),
      ),
    )

    expect(result).toEqual({ status: "skipped", reason: "llm_skip" })
    expect(ctx.files.get(ctx.memoryPath)).toBe(before.memory)
    expect(ctx.files.get(ctx.userPath)).toBe(before.user)
  })

  test("does not overwrite existing stores for an invalid later decision", async () => {
    const ctx = fixture()
    ctx.setMessages(messages("请完成赛车游戏", "已完成基础建模。", "1"))
    await ctx.run(
      Memory.Service.use((memory) => memory.updateAfterTurn(sessionID, () => Effect.succeed(decision("完成基础建模。")))),
    )
    const before = { memory: ctx.files.get(ctx.memoryPath), user: ctx.files.get(ctx.userPath) }
    ctx.setMessages(messages("继续", "已继续。", "2"))
    const result = await ctx.run(
      Memory.Service.use((memory) =>
        memory.updateAfterTurn(sessionID, () =>
          Effect.succeed({ shouldUpdate: true, reason: "invalid", task: { importance: 99 }, user: [] }),
        ),
      ),
    )

    expect(result).toEqual({ status: "skipped", reason: "llm_invalid" })
    expect(ctx.files.get(ctx.memoryPath)).toBe(before.memory)
    expect(ctx.files.get(ctx.userPath)).toBe(before.user)
  })

  test("writes stable user facts returned by the evaluator", async () => {
    const ctx = fixture()
    ctx.setMessages(messages("我叫金毅阳", "已记录。"))
    await ctx.run(
      Memory.Service.use((memory) =>
        memory.updateAfterTurn(sessionID, () =>
          Effect.succeed(decision("记录用户身份偏好。", [{ importance: 10, keywords: ["姓名"], content: "用户姓名为金毅阳。" }])),
        ),
      ),
    )

    expect(Memory.parseStore("user", ctx.files.get(ctx.userPath)!).entries).toEqual([
      { scope: "user", importance: 10, keywords: ["姓名"], content: "用户姓名为金毅阳。" },
    ])
  })

  test("skips subagent sessions without invoking the evaluator", async () => {
    const childID = SessionID.make("ses_curator_child")
    const ctx = fixture({ parentID: sessionID })
    ctx.setMessages(messages("完成报告", "已完成报告章节。", "child", childID))
    let called = false
    const before = { memory: ctx.files.get(ctx.memoryPath), user: ctx.files.get(ctx.userPath) }
    const result = await ctx.run(
      Memory.Service.use((memory) =>
        memory.updateAfterTurn(childID, () => {
          called = true
          return Effect.succeed(decision("不应写入。"))
        }),
      ),
    )

    expect(result).toEqual({ status: "skipped", reason: "subagent" })
    expect(called).toBe(false)
    expect(ctx.files.get(ctx.memoryPath)).toBe(before.memory)
    expect(ctx.files.get(ctx.userPath)).toBe(before.user)
  })
})
