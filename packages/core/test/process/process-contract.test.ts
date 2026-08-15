import { expect } from "bun:test"
import { realpathSync } from "node:fs"
import { tmpdir } from "node:os"
import { Effect, Exit, Stream } from "effect"
import { AppProcess, type ProcessSpec } from "@jyycode-ai/core/process"
import { testEffect } from "../lib/effect"

const it = testEffect(AppProcess.defaultLayer)
const NODE = process.execPath

const spec = (input: Omit<ProcessSpec, "command" | "args" | "env" | "output"> & {
  args?: readonly string[]
  env?: ProcessSpec["env"]
  output?: ProcessSpec["output"]
}): ProcessSpec => ({
  command: NODE,
  args: input.args ?? [],
  env: input.env ?? { mode: "scrubbed" },
  output: input.output ?? "capture",
  ...input,
})

it.live(
  "runs argv without shell concatenation and applies cwd/env policy",
  Effect.gen(function* () {
    const svc = yield* AppProcess.Service
    const cwd = realpathSync(tmpdir())
    const result = yield* svc.run(
      spec({
        cwd,
        args: [
          "-e",
          "process.stdout.write(JSON.stringify({ argv: process.argv.slice(1), cwd: process.cwd(), value: process.env.CONTRACT_VALUE, secret: process.env.CONTRACT_SECRET }))",
          "argument with spaces",
        ],
        env: { mode: "scrubbed", values: { CONTRACT_VALUE: "explicit" } },
      }),
    )
    const parsed = JSON.parse(result.stdout.toString("utf8")) as {
      argv: string[]
      cwd: string
      value?: string
      secret?: string
    }
    expect(parsed.argv).toEqual(["argument with spaces"])
    expect(realpathSync(parsed.cwd)).toBe(cwd)
    expect(parsed.value).toBe("explicit")
    expect(parsed.secret).toBeUndefined()
  }),
)

it.live(
  "supports stdin, bounded capture, and independent stderr",
  Effect.gen(function* () {
    const svc = yield* AppProcess.Service
    const result = yield* svc.run(
      spec({
        args: [
          "-e",
          "process.stderr.write('error'); process.stdin.on('data', chunk => process.stdout.write(chunk))",
        ],
        stdin: "0123456789",
      }),
      { maxOutputBytes: 5, maxErrorBytes: 3 },
    )
    expect(result.exitCode).toBe(0)
    expect(result.stdout.toString()).toBe("01234")
    expect(result.stderr.toString()).toBe("err")
    expect(result.stdoutTruncated).toBe(true)
    expect(result.stderrTruncated).toBe(true)
  }),
)

it.live(
  "streams combined output and preserves explicit allowed exit codes",
  Effect.gen(function* () {
    const svc = yield* AppProcess.Service
    const lines = yield* svc
      .runStream(
        spec({
          output: "stream",
          args: ["-e", "console.log('out'); console.error('err'); process.exit(7)"],
        }),
        { includeStderr: true, okExitCodes: [7] },
      )
      .pipe(Stream.runCollect)
    expect(Array.from(lines)).toEqual(expect.arrayContaining(["out", "err"]))
  }),
)

it.live(
  "reports timeout and AbortSignal failures while terminating the child",
  Effect.gen(function* () {
    const svc = yield* AppProcess.Service
    const timeout = yield* Effect.exit(
      svc.run(spec({ args: ["-e", "setInterval(() => {}, 60_000)"], timeout: 100 })),
    )
    expect(Exit.isFailure(timeout)).toBe(true)

    const controller = new AbortController()
    controller.abort(new Error("contract abort"))
    const aborted = yield* Effect.exit(
      svc.run(spec({ args: ["-e", "setInterval(() => {}, 60_000)"] }), { signal: controller.signal }),
    )
    expect(Exit.isFailure(aborted)).toBe(true)
  }),
)

it.live(
  "exposes verified process-tree termination on the unified handle",
  Effect.scoped(
    Effect.gen(function* () {
      const svc = yield* AppProcess.Service
      const handle = yield* svc.spawn(spec({ args: ["-e", "setInterval(() => {}, 60_000)"] }))
      expect(yield* handle.isRunning).toBe(true)
      const result = yield* handle.terminate({ graceMs: 100, verifyMs: 2_000, pollMs: 25 })
      expect(["exited", "killed"]).toContain(result.state)
      expect(result.remainingPids).toEqual([])
    }),
  ),
)

