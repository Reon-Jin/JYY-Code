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
      parts: [
        { id: PartID.make(`prt_user_${suffix}`), messageID: userID, sessionID: id, type: "text", text: userText },
      ],
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

function fixture(input?: { parentID?: SessionID; multiAgent?: boolean }) {
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
          Effect.sync(() =>
            files.set(target, typeof content === "string" ? content : new TextDecoder().decode(content)),
          ),
      })
    }),
  ).pipe(Layer.provide(AppFileSystem.defaultLayer))
  const sessionLayer = Layer.mock(Session.Service)({
    get: (id) => Effect.succeed({ id, parentID: input?.parentID, multiAgent: input?.multiAgent } as Session.Info),
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
  test("writes a provisional task memory immediately after receiving a user prompt", async () => {
    const ctx = fixture()
    ctx.setMessages(messages("请完成赛车游戏", "已完成赛车游戏基础建模。"))

    const result = await ctx.run(Memory.Service.use((memory) => memory.updateStepBegin(sessionID)))

    expect(result).toEqual({ status: "updated", taskUpdated: true, userUpdated: 0 })
    const entries = Memory.parseStore("memory", ctx.files.get(ctx.memoryPath)!).entries as Memory.TaskMemoryEntry[]
    expect(entries).toHaveLength(1)
    expect(entries[0]?.sessionID).toBe(sessionID)
    expect(entries[0]?.content).toMatch(/^用户要求.+，我完成了.+$/u)
  })

  test("replaces the provisional entry before the final answer and keeps one entry per session", async () => {
    const ctx = fixture()
    ctx.setMessages(messages("请完成赛车游戏", "已完成赛车游戏基础建模。"))
    await ctx.run(Memory.Service.use((memory) => memory.updateStepBegin(sessionID)))
    const result = await ctx.run(
      Memory.Service.use((memory) =>
        memory.updateAfterTurn(sessionID, () => Effect.succeed(decision("完成基础建模。"))),
      ),
    )

    expect(result).toMatchObject({ status: "updated", taskUpdated: true })
    const entries = Memory.parseStore("memory", ctx.files.get(ctx.memoryPath)!).entries as Memory.TaskMemoryEntry[]
    expect(entries).toHaveLength(1)
    expect(entries[0]).toMatchObject({ sessionID })
    expect(entries[0]?.content).toBe("用户要求请完成赛车游戏，我完成了基础建模。")
  })

  test("uses turn text supplied by the prompt boundary without waiting for message projections", async () => {
    const ctx = fixture()
    ctx.setMessages([])

    const received = await ctx.run(
      Memory.Service.use((memory) => memory.updateStepBegin(sessionID, { userText: "修复记忆写入" })),
    )
    const completed = await ctx.run(
      Memory.Service.use((memory) =>
        memory.updateAfterTurn(sessionID, () => Effect.succeed(decision("修复并验证写入。")), {
          userText: "修复记忆写入",
          assistantText: "已修复并通过测试。",
        }),
      ),
    )

    expect(received).toMatchObject({ status: "updated", taskUpdated: true })
    expect(completed).toMatchObject({ status: "updated", taskUpdated: true })
    const entries = Memory.parseStore("memory", ctx.files.get(ctx.memoryPath)!).entries
    expect(entries).toHaveLength(1)
    expect(entries[0]?.content).toBe("用户要求修复记忆写入，我完成了修复并验证写入。")
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
      Memory.Service.use((memory) =>
        memory.updateAfterTurn(sessionID, () => Effect.succeed(decision("完成基础建模。"))),
      ),
    )
    ctx.setMessages(messages("继续优化", "已完成碰撞性能优化。", "2"))
    await ctx.run(
      Memory.Service.use((memory) =>
        memory.updateAfterTurn(sessionID, () => Effect.succeed(decision("完成碰撞性能优化。"))),
      ),
    )

    const entries = Memory.parseStore("memory", ctx.files.get(ctx.memoryPath)!).entries
    expect(entries).toHaveLength(1)
    expect(entries[0]?.content).toBe("用户要求继续优化，我完成了碰撞性能优化。")
  })

  test("always writes task memory for every turn even when LLM says skip", async () => {
    const ctx = fixture()
    ctx.setMessages(messages("请完成赛车游戏", "已完成基础建模。", "1"))
    await ctx.run(
      Memory.Service.use((memory) =>
        memory.updateAfterTurn(sessionID, () => Effect.succeed(decision("完成基础建模。"))),
      ),
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

    // Every turn triggers a write via fallback, even when LLM says shouldUpdate=false.
    expect(result).toMatchObject({ status: "updated", taskUpdated: true })
    // Store is overwritten by fallback content.
    expect(ctx.files.get(ctx.memoryPath)).not.toBe(before.memory)
  })

  test("falls back to deterministic write when LLM returns an invalid decision", async () => {
    const ctx = fixture()
    ctx.setMessages(messages("请完成赛车游戏", "已完成基础建模。", "1"))
    await ctx.run(
      Memory.Service.use((memory) =>
        memory.updateAfterTurn(sessionID, () => Effect.succeed(decision("完成基础建模。"))),
      ),
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

    // Invalid LLM output now triggers fallback write instead of skipping.
    expect(result).toMatchObject({ status: "updated", taskUpdated: true })
    // Store was overwritten by fallback content (not left untouched).
    expect(ctx.files.get(ctx.memoryPath)).not.toBe(before.memory)
  })

  test("routes user information to USER only in both update phases", async () => {
    const ctx = fixture()
    ctx.setMessages(messages("我叫金毅阳", "已记录。"))
    const received = await ctx.run(Memory.Service.use((memory) => memory.updateStepBegin(sessionID)))

    expect(received).toEqual({ status: "updated", taskUpdated: false, userUpdated: 1 })
    expect(Memory.parseStore("memory", ctx.files.get(ctx.memoryPath)!).entries).toEqual([])
    const userAfterReceived = ctx.files.get(ctx.userPath)

    await ctx.run(
      Memory.Service.use((memory) =>
        memory.updateAfterTurn(sessionID, () =>
          Effect.succeed(
            decision("记录用户身份偏好。", [{ importance: 10, keywords: ["姓名"], content: "用户姓名为金毅阳。" }]),
          ),
        ),
      ),
    )

    expect(Memory.parseStore("memory", ctx.files.get(ctx.memoryPath)!).entries).toEqual([])
    expect(ctx.files.get(ctx.userPath)).not.toBe(userAfterReceived)
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

  test("allows a multi-agent root session to perform both automatic updates", async () => {
    const ctx = fixture({ multiAgent: true })
    ctx.setMessages(messages("修复记忆系统", "已修复并通过测试。", "multi-root"))

    const received = await ctx.run(Memory.Service.use((memory) => memory.updateStepBegin(sessionID)))
    const completed = await ctx.run(
      Memory.Service.use((memory) =>
        memory.updateAfterTurn(sessionID, () => Effect.succeed(decision("修复并验证记忆系统。"))),
      ),
    )

    expect(received).toMatchObject({ status: "updated", taskUpdated: true })
    expect(completed).toMatchObject({ status: "updated", taskUpdated: true })
    const entries = Memory.parseStore("memory", ctx.files.get(ctx.memoryPath)!).entries
    expect(entries).toHaveLength(1)
    expect(entries[0]?.content).toBe("用户要求修复记忆系统，我完成了修复并验证记忆系统。")
  })

  test("skips subagent input-phase updates without mutating either store", async () => {
    const childID = SessionID.make("ses_curator_child_input")
    const ctx = fixture({ parentID: sessionID })
    ctx.setMessages(messages("完成报告", "", "child-input", childID))
    const before = { memory: ctx.files.get(ctx.memoryPath), user: ctx.files.get(ctx.userPath) }

    const result = await ctx.run(Memory.Service.use((memory) => memory.updateStepBegin(childID)))

    expect(result).toEqual({ status: "skipped", reason: "subagent" })
    expect(ctx.files.get(ctx.memoryPath)).toBe(before.memory)
    expect(ctx.files.get(ctx.userPath)).toBe(before.user)
  })
})
