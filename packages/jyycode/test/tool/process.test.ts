import { afterEach, describe, expect } from "bun:test"
import path from "path"
import { Effect, Layer } from "effect"
import { CrossSpawnSpawner } from "@jyycode-ai/core/cross-spawn-spawner"
import { AppFileSystem } from "@jyycode-ai/core/filesystem"
import { Agent } from "@/agent/agent"
import { BackgroundProcess } from "@/process/job"
import { Plugin } from "@/plugin"
import { Config } from "@/config/config"
import { Truncate } from "@/tool/truncate"
import { Tool } from "@/tool/tool"
import { KillProcessTool, ProcessOutputTool, ProcessStartTool } from "@/tool/process"
import { MessageID, SessionID } from "@/session/schema"
import { Permission } from "@/permission"
import { disposeAllInstances, TestInstance, provideInstance } from "../fixture/fixture"
import { testEffect } from "../lib/effect"

afterEach(async () => {
  await disposeAllInstances()
})

const ctx = {
  sessionID: SessionID.make("ses_test-process"),
  messageID: MessageID.make("msg_test"),
  callID: "",
  agent: "build",
  abort: AbortSignal.any([]),
  messages: [],
  metadata: () => Effect.void,
  ask: () => Effect.void,
}

const configLayer = Layer.succeed(
  Config.Service,
  Config.Service.of({
    get: () => Effect.succeed({ shell: process.platform === "win32" ? "powershell" : "bash" }),
    getGlobal: () => Effect.succeed({}),
    update: () => Effect.void,
    updateGlobal: (config) => Effect.succeed({ info: config, changed: false }),
    invalidate: () => Effect.void,
    directories: () => Effect.succeed([]),
    waitForDependencies: () => Effect.void,
  }),
)

const processLayer = Layer.succeed(
  BackgroundProcess.Service,
  BackgroundProcess.Service.of({
    start: (input) =>
      Effect.succeed({
        id: "proc_tooltest",
        command: input.rawCommand,
        cwd: input.cwd,
        title: input.title,
        status: "running",
        started_at: Date.now(),
      }),
    get: (id) =>
      Effect.succeed(
        id === "proc_missing"
          ? undefined
          : {
              id,
              command: "node --version",
              cwd: process.cwd(),
              status: "running",
              started_at: Date.now(),
            },
      ),
    output: (input) =>
      Effect.succeed(
        input.id === "proc_missing"
          ? { output: "" }
          : {
              info: {
                id: input.id,
                command: "node --version",
                cwd: process.cwd(),
                status: "running",
                started_at: Date.now(),
              },
              output: "ready\n",
            },
      ),
    kill: (input) =>
      Effect.succeed(
        input.id === "proc_missing"
          ? undefined
          : {
              id: input.id,
              command: "node --version",
              cwd: process.cwd(),
              status: "cancelled",
              started_at: Date.now(),
              completed_at: Date.now(),
              exit: null,
            },
      ),
  }),
)

const layer = Layer.mergeAll(
  Agent.defaultLayer,
  processLayer,
  CrossSpawnSpawner.defaultLayer,
  AppFileSystem.defaultLayer,
  Plugin.defaultLayer,
  configLayer,
  Truncate.defaultLayer,
)

const it = testEffect(layer)

const startTool = Effect.fn("ProcessToolTest.startTool")(function* () {
  const info = yield* ProcessStartTool
  return yield* info.init()
})

const outputTool = Effect.fn("ProcessToolTest.outputTool")(function* () {
  const info = yield* ProcessOutputTool
  return yield* info.init()
})

const killTool = Effect.fn("ProcessToolTest.killTool")(function* () {
  const info = yield* KillProcessTool
  return yield* info.init()
})

const runStart = Effect.fn("ProcessToolTest.runStart")(function* (
  args: Tool.InferParameters<typeof ProcessStartTool>,
  next: Tool.Context = ctx,
) {
  const tool = yield* startTool()
  return yield* tool.execute(args, next)
})

const runOutput = Effect.fn("ProcessToolTest.runOutput")(function* (args: Tool.InferParameters<typeof ProcessOutputTool>) {
  const tool = yield* outputTool()
  return yield* tool.execute(args, ctx)
})

const runKill = Effect.fn("ProcessToolTest.runKill")(function* (args: Tool.InferParameters<typeof KillProcessTool>) {
  const tool = yield* killTool()
  return yield* tool.execute(args, ctx)
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

describe("tool.process", () => {
  it.instance("starts, reads, and kills a background process", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      const started = yield* runStart({
        command: "node --version",
        workdir: test.directory,
        description: "Run test background process",
      })
      const id = String(started.metadata.process_id)

      expect(id.startsWith("proc_")).toBe(true)
      expect(started.output).toContain("Started background process")

      const output = yield* runOutput({ id })
      expect(output.output).toContain("ready")
      expect(output.metadata.status).toBe("running")

      const killed = yield* runKill({ id, forceAfterMs: 100 })
      expect(killed.metadata.status).toBe("cancelled")
    }),
    20_000,
  )

  it.instance("asks shell permissions before starting", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      const { items, next } = asks()
      const started = yield* runStart(
        {
          command: "node --version",
          workdir: test.directory,
          description: "Run permission process",
        },
        next,
      )

      expect(started.metadata.process_id).toBe("proc_tooltest")

      expect(items.some((item) => item.permission === "bash")).toBe(true)
    }),
    20_000,
  )

  it.instance("reports missing process ids", () =>
    Effect.gen(function* () {
      const result = yield* provideInstance(path.resolve("."))(runOutput({ id: "proc_missing" }))

      expect(result.metadata.status).toBe("missing")
      expect(result.output).toContain("No background process found")
    }),
  )
})
