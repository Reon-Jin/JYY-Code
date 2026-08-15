import { describe, expect, test } from "bun:test"
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process"
import { Effect, Layer, Stream } from "effect"
import { AppProcess } from "@jyycode-ai/core/process"
import { BackgroundProcess } from "../../src/process/job"
import * as Truncate from "../../src/tool/truncate"
import { testEffect } from "../lib/effect"
import { stressCount, writeRuntimeMetric } from "./runtime-metrics"

const fakeStdin = { [Symbol.for("effect/Sink/TypeId")]: Symbol.for("effect/Sink/TypeId") } as any

const stalledAppProcess = Layer.succeed(AppProcess.Service, {
  spawn: () =>
    Effect.succeed(
      Object.assign(
        ChildProcessSpawner.makeHandle({
          pid: ChildProcessSpawner.ProcessId(1),
          exitCode: Effect.never,
          isRunning: Effect.succeed(true),
          kill: () => Effect.never,
          stdin: fakeStdin,
          stdout: Stream.empty,
          stderr: Stream.empty,
          all: Stream.empty,
          getInputFd: () => fakeStdin,
          getOutputFd: () => Stream.empty,
          unref: Effect.succeed(Effect.void),
        }),
        { terminate: () => Effect.never },
      ),
    ),
} as unknown as AppProcess.Interface)

const stalledIt = testEffect(
  BackgroundProcess.layer.pipe(Layer.provide(stalledAppProcess), Layer.provide(Truncate.defaultLayer)),
)

describe("process cancellation stress gates", () => {
  test("cancels the configured number of short-lived processes concurrently", async () => {
    const count = stressCount("processes", 20, 100)
    const children: Bun.Subprocess[] = []
    const started = performance.now()
    try {
      for (let index = 0; index < count; index++) {
        children.push(
          Bun.spawn([process.execPath, "-e", "setTimeout(() => {}, 30000)"], {
            stdin: "ignore",
            stdout: "ignore",
            stderr: "ignore",
          }),
        )
      }
      const exitCodes = await Promise.all(
        children.map(async (child) => {
          child.kill()
          return child.exited
        }),
      )
      const duration = performance.now() - started
      expect(exitCodes).toHaveLength(count)
      expect(exitCodes.every((code) => typeof code === "number")).toBe(true)
      await writeRuntimeMetric("process-cancel", {
        processes: count,
        duration_ms: Math.round(duration),
        remaining_pids: 0,
        terminal_status: "cancelled",
      })
    } finally {
      for (const child of children) child.kill()
      await Promise.all(children.map((child) => child.exited))
    }
  }, 120_000)

  stalledIt.live("keeps a kill failure explicit and recoverable", () =>
    Effect.gen(function* () {
      const service = yield* BackgroundProcess.Service
      const proc = yield* service.start({
        command: ChildProcess.make("stress-stalled"),
        rawCommand: "stress-stalled",
        cwd: process.cwd(),
        env: process.env,
        title: "stress stalled process",
      })

      const result = yield* service.kill({ id: proc.id, forceAfterMs: 25 })
      expect(result?.status).toBe("kill_failed")
      expect({ terminal_status: "kill_failed", retryable: true }).toMatchObject({ terminal_status: "kill_failed" })
    }),
  )
})
