import { describe, expect } from "bun:test"
import { Effect, Layer, Stream } from "effect"
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process"
import { BackgroundProcess } from "@/process/job"
import * as Truncate from "@/tool/truncate"
import { testEffect } from "../lib/effect"
import { pollWithTimeout } from "../lib/effect"

const it = testEffect(BackgroundProcess.defaultLayer)

const stalledSpawner = Layer.succeed(
  ChildProcessSpawner.ChildProcessSpawner,
  ChildProcessSpawner.make(() =>
    Effect.succeed(
      ChildProcessSpawner.makeHandle({
        pid: ChildProcessSpawner.ProcessId(1),
        exitCode: Effect.never,
        isRunning: Effect.succeed(true),
        kill: () => Effect.never,
        stdin: { [Symbol.for("effect/Sink/TypeId")]: Symbol.for("effect/Sink/TypeId") } as any,
        stdout: Stream.empty,
        stderr: Stream.empty,
        all: Stream.empty,
        getInputFd: () => ({ [Symbol.for("effect/Sink/TypeId")]: Symbol.for("effect/Sink/TypeId") }) as any,
        getOutputFd: () => Stream.empty,
        unref: Effect.succeed(Effect.void),
      }),
    ),
  ),
)

const stalledIt = testEffect(
  BackgroundProcess.layer.pipe(Layer.provide(stalledSpawner), Layer.provide(Truncate.defaultLayer)),
)

let ownedPid = 10
const ownedSpawner = Layer.succeed(
  ChildProcessSpawner.ChildProcessSpawner,
  ChildProcessSpawner.make(() =>
    Effect.succeed(
      ChildProcessSpawner.makeHandle({
        pid: ChildProcessSpawner.ProcessId(ownedPid++),
        exitCode: Effect.never,
        isRunning: Effect.succeed(true),
        kill: () => Effect.succeed(undefined),
        stdin: { [Symbol.for("effect/Sink/TypeId")]: Symbol.for("effect/Sink/TypeId") } as any,
        stdout: Stream.empty,
        stderr: Stream.empty,
        all: Stream.empty,
        getInputFd: () => ({ [Symbol.for("effect/Sink/TypeId")]: Symbol.for("effect/Sink/TypeId") }) as any,
        getOutputFd: () => Stream.empty,
        unref: Effect.succeed(Effect.void),
      }),
    ),
  ),
)

const ownedIt = testEffect(
  BackgroundProcess.layer.pipe(Layer.provide(ownedSpawner), Layer.provide(Truncate.defaultLayer)),
)

describe("process.job", () => {
  it.instance("starts a process and captures output while running", () =>
    Effect.gen(function* () {
      const service = yield* BackgroundProcess.Service
      const code = "console.log('ready'); setTimeout(() => {}, 30000)"
      const proc = yield* service.start({
        command: ChildProcess.make(process.execPath, ["-e", code], {
          cwd: process.cwd(),
          env: process.env,
          stdin: "ignore",
        }),
        rawCommand: `${process.execPath} -e ${JSON.stringify(code)}`,
        cwd: process.cwd(),
        env: process.env,
        title: "test process",
      })

      const output = yield* pollWithTimeout(
        service
          .output({ id: proc.id, limit: 20 })
          .pipe(Effect.map((output) => (output.output.includes("ready") ? output : undefined))),
        "process output not captured",
      )

      expect(proc.id.startsWith("proc_")).toBe(true)
      expect(output.info?.status).toBe("running")
      expect(output.output).toContain("ready")

      yield* service.kill({ id: proc.id, forceAfterMs: 100 })
    }),
  )

  it.instance("reports missing process ids", () =>
    Effect.gen(function* () {
      const service = yield* BackgroundProcess.Service
      const output = yield* service.output({ id: "proc_missing" })

      expect(output.info).toBeUndefined()
    }),
  )

  stalledIt.live("finishes a kill when the child handle never responds", () =>
    Effect.gen(function* () {
      const service = yield* BackgroundProcess.Service
      const proc = yield* service.start({
        command: ChildProcess.make("ignored"),
        rawCommand: "ignored",
        cwd: process.cwd(),
        env: process.env,
        title: "stalled process",
      })

      const started = Date.now()
      const result = yield* service.kill({ id: proc.id, forceAfterMs: 50 })

      expect(Date.now() - started).toBeLessThan(1_000)
      expect(result?.status).toBe("kill_failed")
    }),
  )

  it.instance("watchdog marks a confirmed timeout and records ownership", () =>
    Effect.gen(function* () {
      const service = yield* BackgroundProcess.Service
      const proc = yield* service.start({
        command: ChildProcess.make(process.execPath, ["-e", "setTimeout(() => {}, 30000)"], {
          cwd: process.cwd(),
          env: process.env,
          stdin: "ignore",
        }),
        rawCommand: "background timeout fixture",
        cwd: process.cwd(),
        env: process.env,
        owner_session_id: "ses_owner",
        timeout: 100,
      })

      expect(proc.owner_session_id).toBe("ses_owner")
      expect(proc.deadline_at).toBeGreaterThan(proc.started_at)
      const result = yield* pollWithTimeout(
        service.get(proc.id).pipe(Effect.map((info) => (info && info.status !== "running" ? info : undefined))),
        "background process watchdog did not time out",
      )
      expect(result.status).toBe("timed_out")
      expect(result.termination_reason).toBe("deadline_exceeded")
    }),
  )

  ownedIt.live("cancels only processes owned by the requested session", () =>
    Effect.gen(function* () {
      const service = yield* BackgroundProcess.Service
      const input = (owner_session_id: string) => ({
        command: ChildProcess.make("ignored"),
        rawCommand: "ignored",
        cwd: process.cwd(),
        env: process.env,
        owner_session_id,
      })
      const owned = yield* service.start(input("ses_owner"))
      const other = yield* service.start(input("ses_other"))
      const cancelled = yield* service.cancelOwner("ses_owner")

      expect(cancelled.map((info) => info.id)).toEqual([owned.id])
      expect((yield* service.get(owned.id))?.status).toBe("cancelled")
      expect((yield* service.get(other.id))?.status).toBe("running")
    }),
  )
})
