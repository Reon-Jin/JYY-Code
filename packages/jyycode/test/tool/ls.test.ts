import { afterEach, describe, expect } from "bun:test"
import path from "path"
import { Cause, Effect, Exit, Layer } from "effect"
import { Agent } from "@/agent/agent"
import { CrossSpawnSpawner } from "@jyycode-ai/core/cross-spawn-spawner"
import { AppFileSystem } from "@jyycode-ai/core/filesystem"
import { LSP } from "@/lsp/lsp"
import { Instruction } from "@/session/instruction"
import { Truncate } from "@/tool/truncate"
import { Tool } from "@/tool/tool"
import { LsTool } from "@/tool/ls"
import { SessionID, MessageID } from "@/session/schema"
import { Permission } from "@/permission"
import { disposeAllInstances, provideInstance, tmpdirScoped } from "../fixture/fixture"
import { testEffect } from "../lib/effect"

afterEach(async () => {
  await disposeAllInstances()
})

const ctx = {
  sessionID: SessionID.make("ses_test-ls"),
  messageID: MessageID.make("msg_test"),
  callID: "",
  agent: "build",
  abort: AbortSignal.any([]),
  messages: [],
  metadata: () => Effect.void,
  ask: () => Effect.void,
}

const layer = Layer.mergeAll(
  Agent.defaultLayer,
  CrossSpawnSpawner.defaultLayer,
  AppFileSystem.defaultLayer,
  Instruction.defaultLayer,
  LSP.defaultLayer,
  Truncate.defaultLayer,
)

const it = testEffect(layer)

const init = Effect.fn("LsToolTest.init")(function* () {
  const info = yield* LsTool
  return yield* info.init()
})

const run = Effect.fn("LsToolTest.run")(function* (
  args: Tool.InferParameters<typeof LsTool>,
  next: Tool.Context = ctx,
) {
  const tool = yield* init()
  return yield* tool.execute(args, next)
})

const exec = Effect.fn("LsToolTest.exec")(function* (
  dir: string,
  args: Tool.InferParameters<typeof LsTool>,
  next: Tool.Context = ctx,
) {
  return yield* provideInstance(dir)(run(args, next))
})

const fail = Effect.fn("LsToolTest.fail")(function* (
  dir: string,
  args: Tool.InferParameters<typeof LsTool>,
  next: Tool.Context = ctx,
) {
  const exit = yield* exec(dir, args, next).pipe(Effect.exit)
  if (Exit.isFailure(exit)) {
    const err = Cause.squash(exit.cause)
    return err instanceof Error ? err : new Error(String(err))
  }
  throw new Error("expected ls to fail")
})

const put = Effect.fn("LsToolTest.put")(function* (p: string, content: string) {
  const fs = yield* AppFileSystem.Service
  yield* fs.writeWithDirs(p, content)
})

const asks = () => {
  const items: Array<Omit<Permission.Request, "id" | "sessionID" | "tool">> = []
  return {
    items,
    next: {
      ...ctx,
      ask: (req: Omit<Permission.Request, "id" | "sessionID" | "tool">) =>
        Effect.sync(() => {
          items.push(req)
        }),
    },
  }
}

describe("tool.ls", () => {
  it.live("lists a directory without reading file contents", () =>
    Effect.gen(function* () {
      const dir = yield* tmpdirScoped()
      yield* put(path.join(dir, "src", "index.ts"), "export const value = 1\n")
      yield* put(path.join(dir, "README.md"), "# title\n")

      const result = yield* exec(dir, { path: dir })

      expect(result.output).toContain("<type>directory</type>")
      expect(result.output).toContain("README.md")
      expect(result.output).toContain("src/")
      expect(result.output).not.toContain("export const value")
    }),
  )

  it.live("renders nested tree output up to depth", () =>
    Effect.gen(function* () {
      const dir = yield* tmpdirScoped()
      yield* put(path.join(dir, "src", "tool", "read.ts"), "read")
      yield* put(path.join(dir, "src", "tool", "edit.ts"), "edit")

      const result = yield* exec(dir, { path: dir, depth: 3 })

      expect(result.output).toContain("src/")
      expect(result.output).toContain("  tool/")
      expect(result.output).toContain("    read.ts")
      expect(result.output).toContain("    edit.ts")
    }),
  )

  it.live("hides dotfiles by default and can include them", () =>
    Effect.gen(function* () {
      const dir = yield* tmpdirScoped()
      yield* put(path.join(dir, ".env"), "secret")
      yield* put(path.join(dir, "visible.txt"), "ok")

      const hidden = yield* exec(dir, { path: dir })
      const shown = yield* exec(dir, { path: dir, showHidden: true })

      expect(hidden.output).toContain("visible.txt")
      expect(hidden.output).not.toContain(".env")
      expect(shown.output).toContain(".env")
    }),
  )

  it.live("enforces limit and reports truncation", () =>
    Effect.gen(function* () {
      const dir = yield* tmpdirScoped()
      for (let i = 0; i < 5; i++) {
        yield* put(path.join(dir, `file-${i}.txt`), String(i))
      }

      const result = yield* exec(dir, { path: dir, limit: 2 })

      expect(result.metadata.truncated).toBe(true)
      expect(result.output).toContain("Showing 2 of")
    }),
  )

  it.live("fails when path is a file", () =>
    Effect.gen(function* () {
      const dir = yield* tmpdirScoped()
      const file = path.join(dir, "file.txt")
      yield* put(file, "content")

      const err = yield* fail(dir, { path: file })

      expect(err.message).toContain("Path is a file, not a directory")
    }),
  )

  it.live("asks for read permission", () =>
    Effect.gen(function* () {
      const dir = yield* tmpdirScoped()
      yield* put(path.join(dir, "a.txt"), "a")
      const { items, next } = asks()

      yield* exec(dir, { path: dir }, next)

      expect(items.some((item) => item.permission === "read")).toBe(true)
    }),
  )
})
