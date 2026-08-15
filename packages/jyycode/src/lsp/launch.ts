import { PassThrough } from "node:stream"
import { AppProcess, type ProcessSpec } from "@jyycode-ai/core/process"
import type { TerminationResult } from "@jyycode-ai/core/process-supervisor"
import { Effect, Scope, Stream } from "effect"
import type * as PlatformError from "effect/PlatformError"

export type LSPProcess = {
  pid: number
  stdin: PassThrough
  stdout: PassThrough
  stderr: PassThrough
  /** Resolves once the AppProcess handle and its stream pumps are ready. */
  ready: Promise<void>
  exited: Promise<number>
  terminate: () => Promise<TerminationResult>
}

export type Runtime = {
  spawn: (spec: ProcessSpec) => LSPProcess
  run: (spec: ProcessSpec) => Promise<AppProcess.RunResult>
}

let configured: Runtime | undefined

export function configure(runtime: Runtime) {
  configured = runtime
  return () => {
    if (configured === runtime) configured = undefined
  }
}

function current() {
  if (!configured) throw new Error("LSP process runtime has not been configured")
  return configured
}

export function spawn(spec: ProcessSpec) {
  return current().spawn(spec)
}

export function run(spec: ProcessSpec) {
  return current().run(spec)
}

function streamPump(source: Stream.Stream<Uint8Array, unknown>, target: PassThrough) {
  return Stream.runForEach(source, (chunk) => Effect.sync(() => target.write(Buffer.from(chunk)))).pipe(
    Effect.ensuring(Effect.sync(() => target.end())),
  )
}

function makeRuntime(appProcess: AppProcess.Interface, scope: Scope.Scope): Runtime {
  return {
    spawn(spec) {
      const stdin = new PassThrough()
      const stdout = new PassThrough()
      const stderr = new PassThrough()
      let pid = 0
      let handle: AppProcess.AppProcessHandle | undefined

      const ready = Effect.runPromise(
        Effect.gen(function* () {
          const input = {
            ...spec,
            stdin: Stream.fromAsyncIterable(
              stdin as AsyncIterable<Uint8Array>,
              (error) => error as PlatformError.PlatformError,
            ),
          } satisfies ProcessSpec
          handle = yield* appProcess.spawn(input)
          pid = Number(handle.pid)
          yield* Effect.forkScoped(streamPump(handle.stdout, stdout))
          yield* Effect.forkScoped(streamPump(handle.stderr, stderr))
        }).pipe(Effect.provideService(Scope.Scope, scope)),
      )

      const exited = ready.then(
        () =>
          Effect.runPromise(handle!.exitCode).then(
            (code) => code,
            () => 1,
          ),
        (error) => Promise.reject(error),
      )

      return {
        get pid() {
          return pid
        },
        stdin,
        stdout,
        stderr,
        ready,
        exited,
        terminate: async () => {
          try {
            await ready
            return await Effect.runPromise(handle!.terminate())
          } catch (error) {
            return {
              state: "kill_failed",
              pid,
              remainingPids: pid > 0 ? [pid] : [],
              error: error instanceof Error ? error.message : String(error),
            } satisfies TerminationResult
          }
        },
      }
    },
    run(spec) {
      return Effect.runPromise(appProcess.run(spec))
    },
  }
}

export function configureFrom(appProcess: AppProcess.Interface, scope: Scope.Scope) {
  return configure(makeRuntime(appProcess, scope))
}

export async function terminate(process: LSPProcess | { pid?: number; kill?: () => void; exited?: Promise<number> }) {
  if ("terminate" in process && typeof process.terminate === "function") return process.terminate()
  const legacy = process as { pid?: number; kill?: () => void; exited?: Promise<number> }
  legacy.kill?.()
  await legacy.exited?.catch(() => undefined)
  return { state: "killed", pid: legacy.pid ?? 0, remainingPids: [] } satisfies TerminationResult
}

export * as LSPLaunch from "./launch"
