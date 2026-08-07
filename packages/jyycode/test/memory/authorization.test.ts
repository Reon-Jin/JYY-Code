import { describe, expect, test } from "bun:test"
import path from "path"
import { AppFileSystem } from "@jyycode-ai/core/filesystem"
import { Effect, Layer } from "effect"
import { Memory } from "@/memory/memory"
import { Session } from "@/session/session"
import { SessionID } from "@/session/schema"

const rootID = SessionID.make("ses_root")
const multiAgentRootID = SessionID.make("ses_multi_root")
const childID = SessionID.make("ses_child")

function fixture() {
  const memoryPath = path.join(Memory.DIRECTORY, "MEMORY.json")
  const userPath = path.join(Memory.DIRECTORY, "USER.json")
  const files = new Map<string, string>([
    [
      memoryPath,
      Memory.serializeStore("memory", [
        {
          scope: "memory",
          sessionID: rootID,
          importance: 6,
          date: "20260705",
          keywords: ["ext", "项目"],
          content: "existing project fact",
        },
      ]),
    ],
    [
      userPath,
      Memory.serializeStore("user", [
        { scope: "user", importance: 8, keywords: ["ext", "user"], content: "existing user fact" },
      ]),
    ],
  ])
  const mtimes = new Map<string, number>([
    [memoryPath, 1],
    [userPath, 1],
  ])

  const fsLayer = Layer.effect(
    AppFileSystem.Service,
    Effect.gen(function* () {
      const fs = yield* AppFileSystem.Service
      return AppFileSystem.Service.of({
        ...fs,
        ensureDir: () => Effect.void,
        existsSafe: (target) => Effect.succeed(files.has(target)),
        readFileStringSafe: (target) => Effect.succeed(files.get(target)),
        writeFileString: (target, content) =>
          Effect.sync(() => {
            files.set(target, content)
            mtimes.set(target, (mtimes.get(target) ?? 0) + 1)
          }),
        rename: (from, to) =>
          Effect.sync(() => {
            const content = files.get(from)
            if (content === undefined) throw new Error(`Missing mock file: ${from}`)
            files.set(to, content)
            files.delete(from)
            mtimes.set(to, (mtimes.get(to) ?? 0) + 1)
          }),
        remove: (target) => Effect.sync(() => void files.delete(target)),
        writeWithDirs: (target, content) =>
          Effect.sync(() => {
            files.set(target, typeof content === "string" ? content : new TextDecoder().decode(content))
            mtimes.set(target, (mtimes.get(target) ?? 0) + 1)
          }),
      })
    }),
  ).pipe(Layer.provide(AppFileSystem.defaultLayer))
  const sessionLayer = Layer.mock(Session.Service)({
    get: (sessionID) =>
      Effect.succeed({
        id: sessionID,
        parentID: sessionID === childID ? rootID : undefined,
        multiAgent: sessionID === multiAgentRootID,
      } as Session.Info),
    messages: () => Effect.succeed([]),
  })
  const layer = Memory.layer.pipe(Layer.provide(Layer.merge(fsLayer, sessionLayer)))
  const run = <A, E>(effect: Effect.Effect<A, E, Memory.Service>) =>
    Effect.runPromise(effect.pipe(Effect.provide(layer)))

  return { files, mtimes, memoryPath, userPath, run }
}

describe("memory write authorization", () => {
  test("allows ordinary and multi-agent root sessions to write", async () => {
    for (const sessionID of [rootID, multiAgentRootID]) {
      const { run } = fixture()
      const result = await run(
        Memory.Service.use((memory) =>
          memory.write({
            sessionID,
            scope: "memory",
            section: "General",
            content: `当前任务：根会话写入；进展：完成权限校验；下一步：验证写入边界`,
            reason: "authorization test",
          }),
        ),
      )
      expect(["written", "replaced"]).toContain(result.status)
      const text = await run(Memory.Service.use((memory) => memory.read({ sessionID, scope: "memory" })))
      expect(() => Memory.parseStore("memory", text)).not.toThrow()
    }
  })

  test("rejects every direct child-session mutation without changing either store", async () => {
    const { run, files, mtimes, memoryPath, userPath } = fixture()
    const before = {
      memory: files.get(memoryPath),
      user: files.get(userPath),
      memoryMtime: mtimes.get(memoryPath),
      userMtime: mtimes.get(userPath),
    }

    const results = await run(
      Memory.Service.use((memory) =>
        Effect.all([
          Effect.flip(
            memory.write({
              sessionID: childID,
              scope: "memory",
              section: "General",
              content: "forbidden add",
              reason: "authorization test",
            }),
          ),
          Effect.flip(
            memory.replaceBySubstring({
              sessionID: childID,
              scope: "memory",
              oldText: "existing project",
              newContent: "forbidden replace",
              reason: "authorization test",
            }),
          ),
          Effect.flip(
            memory.removeBySubstring({
              sessionID: childID,
              scope: "user",
              oldText: "existing user",
              reason: "authorization test",
            }),
          ),
          Effect.flip(memory.compact({ sessionID: childID, scope: "memory" })),
        ]),
      ),
    )

    for (const error of results) expect(error).toBeInstanceOf(Memory.MemoryWriteForbidden)
    expect(files.get(memoryPath)).toBe(before.memory)
    expect(files.get(userPath)).toBe(before.user)
    expect(mtimes.get(memoryPath)).toBe(before.memoryMtime)
    expect(mtimes.get(userPath)).toBe(before.userMtime)
  })

  test("skips child post-turn updates and leaves both stores untouched", async () => {
    const { run, files, mtimes, memoryPath, userPath } = fixture()
    const beforeMemory = files.get(memoryPath)
    const beforeUser = files.get(userPath)
    const beforeMemoryMtime = mtimes.get(memoryPath)
    const beforeUserMtime = mtimes.get(userPath)

    const result = await run(Memory.Service.use((memory) => memory.updateAfterTurn(childID)))

    expect(result).toEqual({ status: "skipped", reason: "subagent" })
    expect(files.get(memoryPath)).toBe(beforeMemory)
    expect(files.get(userPath)).toBe(beforeUser)
    expect(mtimes.get(memoryPath)).toBe(beforeMemoryMtime)
    expect(mtimes.get(userPath)).toBe(beforeUserMtime)
  })

  test("keeps reads available to child sessions", async () => {
    const { run } = fixture()
    const result = await run(
      Memory.Service.use((memory) =>
        Effect.all([
          memory.read({ sessionID: childID, scope: "memory" }),
        ]),
      ),
    )

    expect(result[0]).toContain("existing project fact")
  })
})
