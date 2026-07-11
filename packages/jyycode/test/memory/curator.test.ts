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
    reason: "semantic compression",
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

describe("two-phase semantic memory curator", () => {
  test("uses the LLM to store a semantic user summary immediately after a prompt", async () => {
    const ctx = fixture()
    const longPrompt = `${"背景信息。".repeat(80)}最终要求是完成赛车游戏的碰撞系统。`
    ctx.setMessages(messages(longPrompt, ""))
    let received: Memory.DecisionInput | undefined

    const result = await ctx.run(
      Memory.Service.use((memory) =>
        memory.updateStepBegin(sessionID, (input) => {
          received = input
          return Effect.succeed(decision("用户要求完成赛车游戏的碰撞系统"))
        }),
      ),
    )

    expect(result).toEqual({ status: "updated", taskUpdated: true, userUpdated: 0 })
    expect(received).toMatchObject({
      phase: "user",
      previousTaskContent: undefined,
      userText: longPrompt,
      assistantText: "",
    })
    const entries = Memory.parseStore("memory", ctx.files.get(ctx.memoryPath)!).entries as Memory.TaskMemoryEntry[]
    expect(entries).toHaveLength(1)
    expect(entries[0]).toMatchObject({ sessionID, content: "用户要求完成赛车游戏的碰撞系统" })
    expect(entries[0]?.content).not.toContain("...")
  })

  test("adds the semantic completion before returning the final answer and keeps one session entry", async () => {
    const ctx = fixture()
    ctx.setMessages(messages("请完成赛车游戏", "已完成赛车游戏基础建模。"))
    await ctx.run(
      Memory.Service.use((memory) =>
        memory.updateStepBegin(sessionID, () => Effect.succeed(decision("用户要求完成赛车游戏"))),
      ),
    )
    let received: Memory.DecisionInput | undefined
    const result = await ctx.run(
      Memory.Service.use((memory) =>
        memory.updateAfterTurn(sessionID, (input) => {
          received = input
          return Effect.succeed(decision("用户要求完成赛车游戏，我完成了基础建模"))
        }),
      ),
    )

    expect(result).toMatchObject({ status: "updated", taskUpdated: true })
    expect(received).toMatchObject({
      phase: "assistant",
      previousTaskContent: "用户要求完成赛车游戏",
      userText: "请完成赛车游戏",
      assistantText: "已完成赛车游戏基础建模。",
    })
    const entries = Memory.parseStore("memory", ctx.files.get(ctx.memoryPath)!).entries as Memory.TaskMemoryEntry[]
    expect(entries).toHaveLength(1)
    expect(entries[0]?.content).toBe("用户要求完成赛车游戏，我完成了基础建模")
  })

  test("cumulatively recompresses prompt1 and prompt2 into the same entry", async () => {
    const ctx = fixture()
    ctx.setMessages(messages("请完成赛车游戏", "已完成基础建模。", "1"))
    await ctx.run(
      Memory.Service.use((memory) =>
        memory.updateStepBegin(sessionID, () => Effect.succeed(decision("用户要求完成赛车游戏"))),
      ),
    )
    await ctx.run(
      Memory.Service.use((memory) =>
        memory.updateAfterTurn(sessionID, () => Effect.succeed(decision("用户要求完成赛车游戏，我完成了基础建模"))),
      ),
    )

    ctx.setMessages(messages("继续优化碰撞性能", "已完成碰撞性能优化。", "2"))
    let secondPromptInput: Memory.DecisionInput | undefined
    await ctx.run(
      Memory.Service.use((memory) =>
        memory.updateStepBegin(sessionID, (input) => {
          secondPromptInput = input
          return Effect.succeed(decision("用户要求完成赛车游戏并继续优化碰撞性能"))
        }),
      ),
    )
    expect(secondPromptInput).toMatchObject({
      phase: "user",
      previousTaskContent: "用户要求完成赛车游戏，我完成了基础建模",
      userText: "继续优化碰撞性能",
    })
    let secondAnswerInput: Memory.DecisionInput | undefined
    await ctx.run(
      Memory.Service.use((memory) =>
        memory.updateAfterTurn(sessionID, (input) => {
          secondAnswerInput = input
          return Effect.succeed(decision("用户要求完成赛车游戏并继续优化碰撞性能，我完成了基础建模和碰撞性能优化"))
        }),
      ),
    )

    expect(secondAnswerInput).toMatchObject({
      phase: "assistant",
      previousTaskContent: "用户要求完成赛车游戏并继续优化碰撞性能",
      userText: "继续优化碰撞性能",
      assistantText: "已完成碰撞性能优化。",
    })
    const entries = Memory.parseStore("memory", ctx.files.get(ctx.memoryPath)!).entries
    expect(entries).toHaveLength(1)
    expect(entries[0]?.content).toBe("用户要求完成赛车游戏并继续优化碰撞性能，我完成了基础建模和碰撞性能优化")
  })

  test("uses supplied turn text before message projections are available", async () => {
    const ctx = fixture()
    ctx.setMessages([])

    await ctx.run(
      Memory.Service.use((memory) =>
        memory.updateStepBegin(sessionID, () => Effect.succeed(decision("用户要求修复记忆写入")), {
          userText: "修复记忆写入",
        }),
      ),
    )
    await ctx.run(
      Memory.Service.use((memory) =>
        memory.updateAfterTurn(
          sessionID,
          () => Effect.succeed(decision("用户要求修复记忆写入，我完成了修复并验证写入")),
          { userText: "修复记忆写入", assistantText: "已修复并通过测试。" },
        ),
      ),
    )

    const entries = Memory.parseStore("memory", ctx.files.get(ctx.memoryPath)!).entries
    expect(entries).toHaveLength(1)
    expect(entries[0]?.content).toBe("用户要求修复记忆写入，我完成了修复并验证写入")
  })

  test("fails mandatory writes when the evaluator fails or returns invalid content", async () => {
    const ctx = fixture()
    ctx.setMessages(messages("请生成部署报告", "已生成部署报告并通过检查。"))

    await expect(
      ctx.run(
        Memory.Service.use((memory) =>
          memory.updateStepBegin(sessionID, () => Effect.fail(new Error("model unavailable"))),
        ),
      ),
    ).rejects.toThrow("model unavailable")
    expect(Memory.parseStore("memory", ctx.files.get(ctx.memoryPath)!).entries).toEqual([])

    await ctx.run(
      Memory.Service.use((memory) =>
        memory.updateStepBegin(sessionID, () => Effect.succeed(decision("用户要求生成部署报告"))),
      ),
    )
    await expect(
      ctx.run(
        Memory.Service.use((memory) =>
          memory.updateAfterTurn(sessionID, () => Effect.succeed(decision("用户要求生成部署报告"))),
        ),
      ),
    ).rejects.toThrow('expected "用户要求...，我完成了..."')
    const [entry] = Memory.parseStore("memory", ctx.files.get(ctx.memoryPath)!).entries
    expect(entry?.content).toBe("用户要求生成部署报告")
  })

  test("stores stable user facts without omitting the required task entry", async () => {
    const ctx = fixture()
    ctx.setMessages(messages("我叫金毅阳", "已记录。"))
    const userFact = { importance: 10 as const, keywords: ["姓名"], content: "用户姓名为金毅阳。" }

    await ctx.run(
      Memory.Service.use((memory) =>
        memory.updateStepBegin(sessionID, () => Effect.succeed(decision("用户要求记住其姓名为金毅阳", [userFact]))),
      ),
    )
    await ctx.run(
      Memory.Service.use((memory) =>
        memory.updateAfterTurn(sessionID, () =>
          Effect.succeed(decision("用户要求记住其姓名为金毅阳，我完成了记录", [userFact])),
        ),
      ),
    )

    expect(Memory.parseStore("memory", ctx.files.get(ctx.memoryPath)!).entries).toHaveLength(1)
    expect(Memory.parseStore("user", ctx.files.get(ctx.userPath)!).entries).toEqual([{ scope: "user", ...userFact }])
  })

  test("skips subagent sessions without invoking either evaluator", async () => {
    const childID = SessionID.make("ses_curator_child")
    const ctx = fixture({ parentID: sessionID })
    ctx.setMessages(messages("完成报告", "已完成报告章节。", "child", childID))
    let calls = 0
    const evaluator: Memory.DecisionEvaluator = () => {
      calls++
      return Effect.succeed(decision("用户要求不应写入，我完成了不应写入"))
    }
    const before = { memory: ctx.files.get(ctx.memoryPath), user: ctx.files.get(ctx.userPath) }

    const received = await ctx.run(Memory.Service.use((memory) => memory.updateStepBegin(childID, evaluator)))
    const completed = await ctx.run(Memory.Service.use((memory) => memory.updateAfterTurn(childID, evaluator)))

    expect(received).toEqual({ status: "skipped", reason: "subagent" })
    expect(completed).toEqual({ status: "skipped", reason: "subagent" })
    expect(calls).toBe(0)
    expect(ctx.files.get(ctx.memoryPath)).toBe(before.memory)
    expect(ctx.files.get(ctx.userPath)).toBe(before.user)
  })

  test("allows the multi-agent Planner root to perform both mandatory updates", async () => {
    const ctx = fixture({ multiAgent: true })
    ctx.setMessages(messages("修复记忆系统", "已修复并通过测试。", "multi-root"))

    const received = await ctx.run(
      Memory.Service.use((memory) =>
        memory.updateStepBegin(sessionID, () => Effect.succeed(decision("用户要求修复记忆系统"))),
      ),
    )
    const completed = await ctx.run(
      Memory.Service.use((memory) =>
        memory.updateAfterTurn(sessionID, () =>
          Effect.succeed(decision("用户要求修复记忆系统，我完成了修复并验证记忆系统")),
        ),
      ),
    )

    expect(received).toMatchObject({ status: "updated", taskUpdated: true })
    expect(completed).toMatchObject({ status: "updated", taskUpdated: true })
    const entries = Memory.parseStore("memory", ctx.files.get(ctx.memoryPath)!).entries
    expect(entries).toHaveLength(1)
    expect(entries[0]?.content).toBe("用户要求修复记忆系统，我完成了修复并验证记忆系统")
  })
})
