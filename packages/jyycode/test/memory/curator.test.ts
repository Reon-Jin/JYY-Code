import { describe, expect, test } from "bun:test"
import path from "path"
import { AppFileSystem } from "@jyycode-ai/core/filesystem"
import { Effect, Layer } from "effect"
import { Memory } from "@/memory/memory"
import { MessageV2 } from "@/session/message-v2"
import { Session } from "@/session/session"
import { MessageID, PartID, SessionID } from "@/session/schema"

const sessionID = SessionID.make("ses_curator")

function messages(userText: string, assistantText: string, suffix = "1"): MessageV2.WithParts[] {
  const userID = MessageID.make(`msg_user_${suffix}`)
  const assistantID = MessageID.make(`msg_assistant_${suffix}`)
  return [
    {
      info: { id: userID, sessionID, role: "user" } as MessageV2.User,
      parts: [{ id: PartID.make(`prt_user_${suffix}`), messageID: userID, sessionID, type: "text", text: userText }],
    },
    {
      info: { id: assistantID, sessionID, role: "assistant", parentID: userID } as MessageV2.Assistant,
      parts: [
        {
          id: PartID.make(`prt_assistant_${suffix}`),
          messageID: assistantID,
          sessionID,
          type: "text",
          text: assistantText,
        },
      ],
    },
  ]
}

function fixture() {
  const memoryPath = path.join(Memory.DIRECTORY, "MEMORY.md")
  const userPath = path.join(Memory.DIRECTORY, "USER.md")
  const files = new Map<string, string>([
    [memoryPath, "# JYY-Code Memory\n\n<!-- schema: 2; last_compacted: never -->\n"],
    [userPath, "# User Memory\n\n<!-- schema: 2; last_compacted: never -->\n"],
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
    get: (id) => Effect.succeed({ id, parentID: undefined } as Session.Info),
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
  test("extracts completed task outcomes and updates one entry for later progress", async () => {
    const ctx = fixture()
    ctx.setMessages(messages("请完成赛车游戏", "已完成赛车游戏基础建模和地图绘制。", "1"))
    await ctx.run(Memory.Service.use((memory) => memory.updateAfterTurn(sessionID)))

    ctx.setMessages([
      ...messages("请完成赛车游戏", "已完成赛车游戏基础建模和地图绘制。", "1"),
      ...messages("继续优化赛车游戏", "已完成赛车游戏碰撞性能优化并通过测试。", "2"),
    ])
    await ctx.run(Memory.Service.use((memory) => memory.updateAfterTurn(sessionID)))

    const entries = (ctx.files.get(ctx.memoryPath) ?? "")
      .split(/\r?\n/u)
      .filter((line) => line.startsWith("- "))
      .map((line) => Memory.parseEntry("memory", line)) as Memory.TaskMemoryEntry[]
    expect(entries).toHaveLength(1)
    expect(entries[0]!.content).toContain("碰撞性能优化")
  })

  test("extracts explicit name, birthday, and durable preferences", () => {
    const result = Memory.curateTurn({
      sessionID,
      userText: "我叫金毅阳。我的生日是2005年2月18日。以后请始终用中文简洁回答。",
      assistantText: "已记录。",
    })

    expect(result.user.map((entry) => entry.keywords[0])).toEqual(["姓名", "生日", "沟通偏好"])
    expect(result.user.find((entry) => entry.keywords[0] === "生日")?.content).toContain("20050218")
  })

  test.each([
    ["你好", "你好，有什么可以帮你？"],
    ["还没好吗", "当前进度为 60%，尚未完成。"],
    ["运行测试 fixture", "fake world"],
    ["这次不要写代码，只做检查", "已完成检查。"],
  ])("rejects transient turn: %s", (userText, assistantText) => {
    const result = Memory.curateTurn({ sessionID, userText, assistantText })
    expect(result.task).toBeUndefined()
    expect(result.user).toEqual([])
  })

  test("subagent post-turn updates remain skipped", async () => {
    const ctx = fixture()
    const childID = SessionID.make("ses_curator_child")
    const sessionLayer = Layer.mock(Session.Service)({
      get: (id) => Effect.succeed({ id, parentID: sessionID } as Session.Info),
      messages: () => Effect.succeed(messages("完成报告", "已完成报告章节。")),
    })
    const memoryLayer = Memory.layer.pipe(
      Layer.provide(
        Layer.merge(
          Layer.effect(
            AppFileSystem.Service,
            Effect.gen(function* () {
              const fs = yield* AppFileSystem.Service
              return AppFileSystem.Service.of({
                ...fs,
                ensureDir: () => Effect.void,
                existsSafe: (target) => Effect.succeed(ctx.files.has(target)),
                readFileStringSafe: (target) => Effect.succeed(ctx.files.get(target)),
                writeFileString: (target, content) => Effect.sync(() => void ctx.files.set(target, content)),
                rename: (from, to) =>
                  Effect.sync(() => {
                    const content = ctx.files.get(from)
                    if (content !== undefined) ctx.files.set(to, content)
                    ctx.files.delete(from)
                  }),
                remove: (target) => Effect.sync(() => void ctx.files.delete(target)),
              })
            }),
          ).pipe(Layer.provide(AppFileSystem.defaultLayer)),
          sessionLayer,
        ),
      ),
    )
    const before = ctx.files.get(ctx.memoryPath)
    const result = await Effect.runPromise(
      Memory.Service.use((memory) => memory.updateAfterTurn(childID)).pipe(Effect.provide(memoryLayer)),
    )
    expect(result).toEqual({ status: "skipped", reason: "subagent" })
    expect(ctx.files.get(ctx.memoryPath)).toBe(before)
  })
})
