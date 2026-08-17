import { afterEach, describe, expect } from "bun:test"
import path from "path"
import fs from "fs/promises"
import os from "os"
import { Cause, Effect, Exit, Fiber, Layer } from "effect"
import { EditTool } from "@/tool/edit"
import { LSP } from "@/lsp/lsp"
import { AppFileSystem } from "@jyycode-ai/core/filesystem"
import { Format } from "@/format"
import { Agent } from "@/agent/agent"
import { Bus } from "@/bus"
import { Truncate } from "@/tool/truncate"
import { SessionID, MessageID } from "@/session/schema"
import { Tool } from "@/tool/tool"
import { Permission } from "@/permission"
import { disposeAllInstances, TestInstance } from "../fixture/fixture"
import { testEffect } from "../lib/effect"
import { fileWriteLock } from "@/file/write-lock"

const ctx = {
  sessionID: SessionID.make("ses_test-edit"),
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

const init = Effect.fn("EditToolTest.init")(function* () {
  const info = yield* EditTool
  return yield* info.init()
})

const run = Effect.fn("EditToolTest.run")(function* (
  args: Tool.InferParameters<typeof EditTool>,
  next: Tool.Context = ctx,
) {
  const tool = yield* init()
  return yield* tool.execute(args, next)
})

const fail = Effect.fn("EditToolTest.fail")(function* (args: Tool.InferParameters<typeof EditTool>) {
  const exit = yield* run(args).pipe(Effect.exit)
  if (Exit.isFailure(exit)) {
    const err = Cause.squash(exit.cause)
    return err instanceof Error ? err : new Error(String(err))
  }
  throw new Error("expected edit to fail")
})

const put = Effect.fn("EditToolTest.put")(function* (p: string, content: string) {
  const fs = yield* AppFileSystem.Service
  yield* fs.writeWithDirs(p, content)
})

const load = Effect.fn("EditToolTest.load")(function* (p: string) {
  const fs = yield* AppFileSystem.Service
  return yield* fs.readFileString(p)
})

const loadRaw = Effect.fn("EditToolTest.loadRaw")(function* (p: string) {
  return yield* Effect.promise(() => fs.readFile(p, "utf-8"))
})

describe("tool.edit", () => {
  it.instance("denies editing through a symlink that escapes the project", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      const outside = yield* Effect.promise(() => fs.mkdtemp(path.join(os.tmpdir(), "jyycode-edit-outside-")))
      yield* Effect.addFinalizer(() => Effect.promise(() => fs.rm(outside, { recursive: true, force: true })))
      const outsideFile = path.join(outside, "secret.txt")
      const link = path.join(test.directory, "link-outside")
      yield* Effect.promise(() => fs.writeFile(outsideFile, "do not edit", "utf-8"))

      try {
        yield* Effect.promise(() => fs.symlink(outside, link, process.platform === "win32" ? "junction" : "dir"))
      } catch (error) {
        if (process.platform === "win32" && (error as NodeJS.ErrnoException).code === "EPERM") return
        throw error
      }

      let requested = false
      const next = {
        ...ctx,
        ask: (request: Omit<Permission.Request, "id" | "sessionID" | "tool">) => {
          if (request.permission !== "external_directory") return Effect.void
          requested = true
          return Effect.die(new Permission.DeniedError({ ruleset: [] }))
        },
      }
      const exit = yield* run(
        {
          filePath: outsideFile.replace(outside, link),
          edits: [{ oldString: "do not edit", newString: "changed" }],
        },
        next,
      ).pipe(Effect.exit)

      expect(exit._tag).toBe("Failure")
      expect(requested).toBe(true)
      expect(yield* loadRaw(outsideFile)).toBe("do not edit")
    }),
  )

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

      expect(result.output).toContain("Edit applied successfully")
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

  it.instance("fails when the file does not exist", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      const err = yield* fail({
        filePath: path.join(test.directory, "nonexistent.txt"),
        edits: [{ oldString: "old", newString: "new" }],
      })
      expect(err.message).toContain("not found")
    }),
  )

  it.instance("fails when the path is a directory", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      const err = yield* fail({
        filePath: test.directory,
        edits: [{ oldString: "old", newString: "new" }],
      })
      expect(err.message).toContain("directory")
    }),
  )

  it.instance("waits for an external file lock before reading", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      const filepath = path.join(test.directory, "locked.txt")
      yield* put(filepath, "old\n")
      const held = yield* Effect.promise(() => fileWriteLock.acquire(filepath, { holder: "test-holder" }))
      let asked = false
      const pending = yield* run(
        { filePath: filepath, edits: [{ oldString: "old", newString: "new" }] },
        { ...ctx, ask: () => Effect.sync(() => void (asked = true)) },
      ).pipe(Effect.forkScoped)

      yield* Effect.sleep("20 millis")
      expect(asked).toBe(false)
      held.release()

      const result = yield* Fiber.join(pending)
      expect(asked).toBe(true)
      expect(result.metadata.waitedMs).toBeGreaterThanOrEqual(10)
      expect(yield* load(filepath)).toBe("new\n")
    }),
  )
})
