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
    experiences: [],
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
          return Effect.succeed(decision("当前任务：完成赛车游戏的碰撞系统；进展：尚未开始；下一步：实现碰撞系统"))
        }),
      ),
    )

    expect(result).toEqual({ status: "updated", taskUpdated: true, userUpdated: 0, experienceCandidates: [] })
    expect(received).toMatchObject({
      phase: "user",
      previousTaskContent: undefined,
      userText: longPrompt,
      assistantText: "",
    })
    const entries = Memory.parseStore("memory", ctx.files.get(ctx.memoryPath)!).entries as Memory.TaskMemoryEntry[]
    expect(entries).toHaveLength(1)
    expect(entries[0]).toMatchObject({ sessionID, content: "当前任务：完成赛车游戏的碰撞系统；进展：尚未开始；下一步：实现碰撞系统" })
    expect(entries[0]?.content).not.toContain("...")
  })

  test("asks the LLM to correct a business-validation error before blocking the turn", async () => {
    const ctx = fixture()
    ctx.setMessages(messages("创建三步子Agent任务", ""))
    const corrections: Array<string | undefined> = []

    const result = await ctx.run(
      Memory.Service.use((memory) =>
        memory.updateStepBegin(sessionID, (input) => {
          corrections.push(input.correction)
          if (corrections.length === 1) {
            return Effect.succeed({
              ...decision("当前任务：创建三步子Agent任务；进展：准备中；下一步：创建任务"),
              task: { importance: 7, keywords: ["子agent"], content: "当前任务：创建三步子Agent任务；进展：准备中；下一步：创建任务" },
            })
          }
          return Effect.succeed(decision("当前任务：创建三步子Agent任务；进展：准备中；下一步：创建任务"))
        }),
      ),
    )

    expect(result).toMatchObject({ status: "updated", taskUpdated: true })
    expect(corrections).toHaveLength(2)
    expect(corrections[0]).toBeUndefined()
    expect(corrections[1]).toContain('keyword "子agent"')
    const [entry] = Memory.parseStore("memory", ctx.files.get(ctx.memoryPath)!).entries
    expect(entry?.content).toBe("当前任务：创建三步子Agent任务；进展：准备中；下一步：创建任务")
  })

  test("adds the semantic completion before returning the final answer and keeps one session entry", async () => {
    const ctx = fixture()
    ctx.setMessages(messages("请完成赛车游戏", "已完成赛车游戏基础建模。"))
    await ctx.run(
      Memory.Service.use((memory) =>
        memory.updateStepBegin(sessionID, () => Effect.succeed(decision("当前任务：完成赛车游戏；进展：准备中；下一步：开始实现"))),
      ),
    )
    let received: Memory.DecisionInput | undefined
    const result = await ctx.run(
      Memory.Service.use((memory) =>
        memory.updateAfterTurn(sessionID, (input) => {
          received = input
          return Effect.succeed(decision("当前任务：赛车碰撞；进展：完成分层调试与测试；下一步：验证状态隔离"))
        }),
      ),
    )

    expect(result).toMatchObject({ status: "updated", taskUpdated: true })
    expect(received).toMatchObject({
      phase: "assistant",
      previousTaskContent: "当前任务：完成赛车游戏；进展：准备中；下一步：开始实现",
      userText: "请完成赛车游戏",
      assistantText: "已完成赛车游戏基础建模。",
    })
    const entries = Memory.parseStore("memory", ctx.files.get(ctx.memoryPath)!).entries as Memory.TaskMemoryEntry[]
    expect(entries).toHaveLength(1)
    expect(entries[0]?.content).toBe("当前任务：赛车碰撞；进展：完成分层调试与测试；下一步：验证状态隔离")
  })

  test("cumulatively recompresses prompt1 and prompt2 into the same entry", async () => {
    const ctx = fixture()
    ctx.setMessages(messages("请完成赛车游戏", "已完成基础建模。", "1"))
    await ctx.run(
      Memory.Service.use((memory) =>
        memory.updateStepBegin(sessionID, () => Effect.succeed(decision("当前任务：完成赛车游戏；进展：准备中；下一步：开始实现"))),
      ),
    )
    await ctx.run(
      Memory.Service.use((memory) =>
        memory.updateAfterTurn(sessionID, () =>
          Effect.succeed(decision("当前任务：赛车碰撞；进展：完成分层调试；下一步：验证状态隔离")),
        ),
      ),
    )

    ctx.setMessages(messages("继续优化碰撞性能", "已完成碰撞性能优化。", "2"))
    let secondPromptInput: Memory.DecisionInput | undefined
    await ctx.run(
      Memory.Service.use((memory) =>
        memory.updateStepBegin(sessionID, (input) => {
          secondPromptInput = input
          return Effect.succeed(decision("当前任务：完成赛车游戏并优化碰撞性能；进展：基础碰撞完成；下一步：优化性能"))
        }),
      ),
    )
    expect(secondPromptInput).toMatchObject({
      phase: "user",
      previousTaskContent: "当前任务：赛车碰撞；进展：完成分层调试；下一步：验证状态隔离",
      userText: "继续优化碰撞性能",
    })
    let secondAnswerInput: Memory.DecisionInput | undefined
    await ctx.run(
      Memory.Service.use((memory) =>
        memory.updateAfterTurn(sessionID, (input) => {
          secondAnswerInput = input
          return Effect.succeed(decision("当前任务：赛车碰撞与性能；进展：完成瓶颈分析与基准测试；下一步：验证性能优化"))
        }),
      ),
    )

    expect(secondAnswerInput).toMatchObject({
      phase: "assistant",
      previousTaskContent: "当前任务：完成赛车游戏并优化碰撞性能；进展：基础碰撞完成；下一步：优化性能",
      userText: "继续优化碰撞性能",
      assistantText: "已完成碰撞性能优化。",
    })
    const entries = Memory.parseStore("memory", ctx.files.get(ctx.memoryPath)!).entries
    expect(entries).toHaveLength(1)
    expect(entries[0]?.content).toBe("当前任务：赛车碰撞与性能；进展：完成瓶颈分析与基准测试；下一步：验证性能优化")
  })

  test("uses supplied turn text before message projections are available", async () => {
    const ctx = fixture()
    ctx.setMessages([])

    await ctx.run(
      Memory.Service.use((memory) =>
        memory.updateStepBegin(sessionID, () => Effect.succeed(decision("当前任务：修复记忆写入；进展：准备中；下一步：修复写入")), {
          userText: "修复记忆写入",
        }),
      ),
    )
    await ctx.run(
      Memory.Service.use((memory) =>
        memory.updateAfterTurn(
          sessionID,
          () => Effect.succeed(decision("当前任务：修复记忆；进展：完成回归测试；下一步：验证边界校验")),
          { userText: "修复记忆写入", assistantText: "已修复并通过测试。" },
        ),
      ),
    )

    const entries = Memory.parseStore("memory", ctx.files.get(ctx.memoryPath)!).entries
    expect(entries).toHaveLength(1)
    expect(entries[0]?.content).toBe("当前任务：修复记忆；进展：完成回归测试；下一步：验证边界校验")
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
        memory.updateStepBegin(sessionID, () => Effect.succeed(decision("当前任务：生成部署报告；进展：准备中；下一步：生成报告"))),
      ),
    )
    await expect(
      ctx.run(
        Memory.Service.use((memory) =>
          memory.updateAfterTurn(sessionID, () =>
            Effect.succeed(decision("用户要求生成部署报告，我用了模板，最终学会了校验")),
          ),
        ),
      ),
    ).rejects.toThrow('expected "当前任务：<goal>；进展：<progress>；下一步：<next>"')
    const [entry] = Memory.parseStore("memory", ctx.files.get(ctx.memoryPath)!).entries
    expect(entry?.content).toBe("当前任务：生成部署报告；进展：准备中；下一步：生成报告")
  })

  test("stores stable user facts without omitting the required task entry", async () => {
    const ctx = fixture()
    ctx.setMessages(messages("我叫金毅阳", "已记录。"))
    const userFact = { importance: 10 as const, keywords: ["姓名"], content: "用户姓名为金毅阳。" }

    await ctx.run(
      Memory.Service.use((memory) =>
        memory.updateStepBegin(sessionID, () => Effect.succeed(decision("当前任务：记住用户姓名；进展：已记录姓名；下一步：确认偏好", [userFact]))),
      ),
    )
    await ctx.run(
      Memory.Service.use((memory) =>
        memory.updateAfterTurn(sessionID, () =>
          Effect.succeed(decision("当前任务：记住姓名；进展：完成事实抽取；下一步：确认偏好", [userFact])),
        ),
      ),
    )

    expect(Memory.parseStore("memory", ctx.files.get(ctx.memoryPath)!).entries).toHaveLength(1)
    const userEntries = Memory.parseStore("user", ctx.files.get(ctx.userPath)!).entries
    expect(userEntries).toHaveLength(1)
    expect(userEntries[0]).toMatchObject({ scope: "user", ...userFact })
    expect(userEntries[0]?.date).toMatch(/^\d{8}$/u)
  })

  test("coalesces equivalent user candidates returned by one evaluator call", async () => {
    const ctx = fixture()
    ctx.setMessages(messages("我叫金毅阳", "已记录。", "duplicate-user"))

    const result = await ctx.run(
      Memory.Service.use((memory) =>
        memory.updateStepBegin(sessionID, () =>
          Effect.succeed(
            decision("当前任务：记住用户姓名；进展：已记录姓名；下一步：确认偏好", [
              { importance: 8, keywords: ["称呼"], content: "用户名为金毅阳" },
              { importance: 10, keywords: ["姓名"], content: "User name is 金毅阳" },
            ]),
          ),
        ),
      ),
    )

    expect(result).toEqual({ status: "updated", taskUpdated: true, userUpdated: 1, experienceCandidates: [] })
    const stored = Memory.parseStore("user", ctx.files.get(ctx.userPath)!).entries as Memory.UserMemoryEntry[]
    expect(stored).toHaveLength(1)
    expect(stored[0]).toMatchObject({ importance: 10, content: "User name is 金毅阳" })
  })

  test("skips subagent sessions without invoking either evaluator", async () => {
    const childID = SessionID.make("ses_curator_child")
    const ctx = fixture({ parentID: sessionID })
    ctx.setMessages(messages("完成报告", "已完成报告章节。", "child", childID))
    let calls = 0
    const evaluator: Memory.DecisionEvaluator = () => {
      calls++
      return Effect.succeed(decision("当前任务：不应写入；进展：已拦截；下一步：不写入"))
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
        memory.updateStepBegin(sessionID, () => Effect.succeed(decision("当前任务：修复记忆系统；进展：准备中；下一步：修复"))),
      ),
    )
    const completed = await ctx.run(
      Memory.Service.use((memory) =>
        memory.updateAfterTurn(sessionID, () =>
          Effect.succeed(decision("当前任务：修复记忆系统；进展：完成回归测试；下一步：验证生命周期校验")),
        ),
      ),
    )

    expect(received).toMatchObject({ status: "updated", taskUpdated: true })
    expect(completed).toMatchObject({ status: "updated", taskUpdated: true })
    const entries = Memory.parseStore("memory", ctx.files.get(ctx.memoryPath)!).entries
    expect(entries).toHaveLength(1)
    expect(entries[0]?.content).toBe("当前任务：修复记忆系统；进展：完成回归测试；下一步：验证生命周期校验")
  })

  test("requires a failure experience when the turn has a tool failure hint", async () => {
    const ctx = fixture()
    ctx.setMessages(messages("修复部署脚本", "已尝试修复，但脚本仍报错。", "failure"))

    await expect(
      ctx.run(
        Memory.Service.use((memory) =>
          memory.updateAfterTurn(
            sessionID,
            () => Effect.succeed(decision("当前任务：修复部署脚本；进展：完成尝试；下一步：定位报错")),
            { userText: "修复部署脚本", assistantText: "已尝试修复，但脚本仍报错。", failureHint: "Tool shell: exit 1" },
          ),
        ),
      ),
    ).rejects.toThrow("failureHint present: experiences must include a kind=failure entry")

    const failureExperience: Memory.ExperienceCandidate = {
      kind: "failure",
      importance: 8,
      keywords: ["部署"],
      content: "部署脚本报错时先看日志再重试",
      evidence: `[${sessionID}#1] deploy.sh`,
      confidence: "high",
    }
    const result = await ctx.run(
      Memory.Service.use((memory) =>
        memory.updateAfterTurn(
          sessionID,
          () =>
            Effect.succeed({
              ...decision("当前任务：修复部署脚本；进展：完成尝试；下一步：定位报错"),
              experiences: [failureExperience],
            }),
          { userText: "修复部署脚本", assistantText: "已尝试修复，但脚本仍报错。", failureHint: "Tool shell: exit 1" },
        ),
      ),
    )

    expect(result).toMatchObject({ status: "updated", taskUpdated: true, experienceCandidates: [failureExperience] })
  })
})
