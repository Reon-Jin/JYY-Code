import { afterEach, describe, expect } from "bun:test"
import path from "path"
import fs from "fs/promises"
import { Cause, Effect, Exit, Layer } from "effect"
import { MultiEditTool } from "@/tool/multi-edit"
import { LSP } from "@/lsp/lsp"
import { AppFileSystem } from "@jyycode-ai/core/filesystem"
import { Format } from "@/format"
import { Agent } from "@/agent/agent"
import { Bus } from "@/bus"
import { Truncate } from "@/tool/truncate"
import { SessionID, MessageID } from "@/session/schema"
import { Tool } from "@/tool/tool"
import { disposeAllInstances, TestInstance } from "../fixture/fixture"
import { testEffect } from "../lib/effect"

const ctx = {
  sessionID: SessionID.make("ses_test-multi-edit"),
  messageID: MessageID.make("msg_test"),
  callID: "",
  agent: "build",
  abort: AbortSignal.any([]),
  messages: [],
  metadata: () => Effect.void,
  ask: () => Effect.void,
}

afterEach(async () => {
  await disposeAllInstances()
})

const layer = Layer.mergeAll(
  LSP.defaultLayer,
  AppFileSystem.defaultLayer,
  Format.defaultLayer,
  Bus.layer,
  Truncate.defaultLayer,
  Agent.defaultLayer,
)

const it = testEffect(layer)

const init = Effect.fn("MultiEditToolTest.init")(function* () {
  const info = yield* MultiEditTool
  return yield* info.init()
})

const run = Effect.fn("MultiEditToolTest.run")(function* (
  args: Tool.InferParameters<typeof MultiEditTool>,
  next: Tool.Context = ctx,
) {
  const tool = yield* init()
  return yield* tool.execute(args, next)
})

const fail = Effect.fn("MultiEditToolTest.fail")(function* (args: Tool.InferParameters<typeof MultiEditTool>) {
  const exit = yield* run(args).pipe(Effect.exit)
  if (Exit.isFailure(exit)) {
    const err = Cause.squash(exit.cause)
    return err instanceof Error ? err : new Error(String(err))
  }
  throw new Error("expected multi_edit to fail")
})

const put = Effect.fn("MultiEditToolTest.put")(function* (p: string, content: string) {
  const fs = yield* AppFileSystem.Service
  yield* fs.writeWithDirs(p, content)
})

const load = Effect.fn("MultiEditToolTest.load")(function* (p: string) {
  const fs = yield* AppFileSystem.Service
  return yield* fs.readFileString(p)
})

const loadRaw = Effect.fn("MultiEditToolTest.loadRaw")(function* (p: string) {
  return yield* Effect.promise(() => fs.readFile(p, "utf-8"))
})

describe("tool.multi_edit", () => {
  it.instance("applies ordered edits atomically", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      const filepath = path.join(test.directory, "file.txt")
      yield* put(filepath, "alpha\nbeta\ngamma\n")

      const result = yield* run({
        filePath: filepath,
        edits: [
          { oldString: "alpha", newString: "one" },
          { oldString: "gamma", newString: "three" },
        ],
      })

      expect(result.output).toContain("Multi-edit applied successfully")
      expect(yield* load(filepath)).toBe("one\nbeta\nthree\n")
      expect(result.metadata.diff).toContain("-alpha")
      expect(result.metadata.diff).toContain("+one")
    }),
  )

  it.instance("does not write partial changes when a later edit fails", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      const filepath = path.join(test.directory, "file.txt")
      yield* put(filepath, "alpha\nbeta\n")

      const err = yield* fail({
        filePath: filepath,
        edits: [
          { oldString: "alpha", newString: "one" },
          { oldString: "missing", newString: "nope" },
        ],
      })

      expect(err.message).toContain("missing")
      expect(yield* load(filepath)).toBe("alpha\nbeta\n")
    }),
  )

  it.instance("preserves BOM and CRLF", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      const filepath = path.join(test.directory, "file.cs")
      const bom = String.fromCharCode(0xfeff)
      yield* put(filepath, `${bom}using System;\r\nclass Test {}\r\n`)

      yield* run({
        filePath: filepath,
        edits: [
          { oldString: "using System;", newString: "using Up;" },
          { oldString: "class Test {}", newString: "class Demo {}" },
        ],
      })

      const content = yield* loadRaw(filepath)
      expect(content.charCodeAt(0)).toBe(0xfeff)
      expect(content.slice(1)).toBe("using Up;\r\nclass Demo {}\r\n")
    }),
  )

  it.instance("supports replaceAll per edit", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      const filepath = path.join(test.directory, "file.txt")
      yield* put(filepath, "foo foo bar")

      yield* run({
        filePath: filepath,
        edits: [{ oldString: "foo", newString: "baz", replaceAll: true }],
      })

      expect(yield* load(filepath)).toBe("baz baz bar")
    }),
  )
})
