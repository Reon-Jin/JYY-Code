import { Context, Duration, Effect, Fiber, Layer, Schema, Stream } from "effect"
import type { PlatformError } from "effect/PlatformError"
import type * as Scope from "effect/Scope"
import { ChildProcess } from "effect/unstable/process"
import { ChildProcessSpawner, type ChildProcessHandle } from "effect/unstable/process/ChildProcessSpawner"
import { CrossSpawnSpawner } from "./cross-spawn-spawner"
import type { ProcessSpec } from "./process-spec"
import { terminateProcessTree, type TerminationOptions, type TerminationResult } from "./process-supervisor"

export type { ProcessSpec } from "./process-spec"

export class AppProcessError extends Schema.TaggedErrorClass<AppProcessError>()("AppProcessError", {
  command: Schema.String,
  exitCode: Schema.optional(Schema.Number),
  stderr: Schema.optional(Schema.String),
  cause: Schema.optional(Schema.Defect),
}) {}

export interface RunOptions {
  readonly maxOutputBytes?: number
  readonly maxErrorBytes?: number
  readonly signal?: AbortSignal
  readonly timeout?: Duration.Input
  readonly stdin?: string | Uint8Array | Stream.Stream<Uint8Array, PlatformError>
}

export interface RunStreamOptions {
  readonly signal?: AbortSignal
  readonly timeout?: Duration.Input
  readonly includeStderr?: boolean
  readonly okExitCodes?: ReadonlyArray<number>
  readonly maxErrorBytes?: number
}

export type ProcessInput = ChildProcess.Command | ProcessSpec

export type AppProcessHandle = ChildProcessHandle & {
  readonly terminate: (options?: TerminationOptions) => Effect.Effect<TerminationResult, AppProcessError>
}

export interface RunResult {
  readonly command: string
  readonly exitCode: number
  readonly stdout: Buffer
  readonly stderr: Buffer
  readonly stdoutTruncated: boolean
  readonly stderrTruncated: boolean
}

export type Interface = Omit<ChildProcessSpawner["Service"], "spawn"> & {
  readonly spawn: (command: ProcessInput) => Effect.Effect<AppProcessHandle, PlatformError, Scope.Scope>
  readonly run: (command: ProcessInput, options?: RunOptions) => Effect.Effect<RunResult, AppProcessError>
  readonly runStream: (
    command: ProcessInput,
    options?: RunStreamOptions,
  ) => Stream.Stream<string, AppProcessError>
}

export class Service extends Context.Service<Service, Interface>()("@jyycode/AppProcess") {}

export const requireSuccess = (result: RunResult): Effect.Effect<RunResult, AppProcessError> =>
  result.exitCode === 0
    ? Effect.succeed(result)
    : Effect.fail(
        new AppProcessError({
          command: result.command,
          exitCode: result.exitCode,
          stderr: result.stderr.toString("utf8"),
        }),
      )

export const requireExitIn =
  (codes: ReadonlyArray<number>) =>
  (result: RunResult): Effect.Effect<RunResult, AppProcessError> =>
    codes.includes(result.exitCode)
      ? Effect.succeed(result)
      : Effect.fail(
          new AppProcessError({
            command: result.command,
            exitCode: result.exitCode,
            stderr: result.stderr.toString("utf8"),
          }),
        )

const describeCommand = (command: ChildProcess.Command): string => {
  if (command._tag === "StandardCommand") {
    return command.args.length ? `${command.command} ${command.args.join(" ")}` : command.command
  }
  return `${describeCommand(command.left)} | ${describeCommand(command.right)}`
}

const inheritedEnvironmentKeys = [
  "PATH",
  "Path",
  "SystemRoot",
  "WINDIR",
  "ComSpec",
  "PATHEXT",
  "TEMP",
  "TMP",
  "TMPDIR",
  "HOME",
  "USERPROFILE",
  "LANG",
  "LC_ALL",
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "NO_PROXY",
  "ALL_PROXY",
  "http_proxy",
  "https_proxy",
  "no_proxy",
  "all_proxy",
] as const

function environmentFor(spec: ProcessSpec): Record<string, string> {
  const result: Record<string, string> = {}
  if (spec.env.mode === "inherit-allowlist") {
    for (const key of inheritedEnvironmentKeys) {
      const value = process.env[key]
      if (value !== undefined) result[key] = value
    }
  } else {
    // PATH and the Windows loader roots are required to resolve a command;
    // they are the only inherited values in scrubbed mode.
    for (const key of ["PATH", "Path", "SystemRoot", "WINDIR", "ComSpec", "PATHEXT"] as const) {
      const value = process.env[key]
      if (value !== undefined) result[key] = value
    }
  }
  Object.assign(result, spec.env.values ?? {})
  return result
}

function normalizeInput(input: ProcessInput): { command: ChildProcess.Command; timeout?: Duration.Input } {
  if ("env" in input && "output" in input) {
    const options = {
      cwd: input.cwd,
      env: environmentFor(input),
      extendEnv: false,
      shell: input.shell,
      stdin: input.stdin === undefined ? (input.output === "inherit" ? "inherit" : undefined) : normalizeStdin(input.stdin),
      stdout: input.output === "inherit" ? "inherit" : "pipe",
      stderr: input.output === "inherit" ? "inherit" : "pipe",
    }
    return {
      command: ChildProcess.make(input.command, [...input.args], options as ChildProcess.CommandOptions),
      timeout: input.timeout,
    }
  }
  return { command: input }
}

const wrapError = (description: string, cause: unknown): AppProcessError =>
  cause instanceof AppProcessError ? cause : new AppProcessError({ command: description, cause })

const abortError = (signal: AbortSignal): Error => {
  const reason = signal.reason
  if (reason instanceof Error) return reason
  const err = new Error("Aborted")
  err.name = "AbortError"
  return err
}

const waitForAbort = (signal: AbortSignal) =>
  Effect.callback<never, Error>((resume) => {
    if (signal.aborted) {
      resume(Effect.fail(abortError(signal)))
      return
    }
    const onabort = () => resume(Effect.fail(abortError(signal)))
    signal.addEventListener("abort", onabort, { once: true })
    return Effect.sync(() => signal.removeEventListener("abort", onabort))
  })

const normalizeStdin = (
  input: string | Uint8Array | Stream.Stream<Uint8Array, PlatformError>,
): Stream.Stream<Uint8Array, PlatformError> =>
  typeof input === "string"
    ? Stream.make(new TextEncoder().encode(input))
    : input instanceof Uint8Array
      ? Stream.make(input)
      : input

const collectStream = (stream: Stream.Stream<Uint8Array, PlatformError>, maxOutputBytes: number | undefined) =>
  Stream.runFold(
    stream,
    () => ({ chunks: [] as Uint8Array[], bytes: 0, truncated: false }),
    (acc, chunk) => {
      if (maxOutputBytes === undefined) {
        acc.chunks.push(chunk)
        acc.bytes += chunk.length
        return acc
      }
      const remaining = maxOutputBytes - acc.bytes
      if (remaining > 0) acc.chunks.push(remaining >= chunk.length ? chunk : chunk.slice(0, remaining))
      acc.bytes += chunk.length
      acc.truncated = acc.truncated || acc.bytes > maxOutputBytes
      return acc
    },
  ).pipe(Effect.map((x) => ({ buffer: Buffer.concat(x.chunks), truncated: x.truncated })))

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const spawner = yield* ChildProcessSpawner

    const spawnProcess = Effect.fn("AppProcess.spawn")(function* (input: ProcessInput) {
      const { command, timeout } = normalizeInput(input)
      const handle = yield* spawner.spawn(command)
      const terminate = (options?: TerminationOptions) =>
        Effect.tryPromise({
          try: () => terminateProcessTree(Number(handle.pid), options),
          catch: (cause) => wrapError(describeCommand(command), cause),
        })
      const result = Object.assign(Object.create(Object.getPrototypeOf(handle)), handle, { terminate }) as AppProcessHandle
      if (timeout !== undefined) {
        yield* Effect.forkScoped(
          Effect.sleep(timeout).pipe(
            Effect.andThen(
              Effect.gen(function* () {
                if (yield* result.isRunning) yield* result.terminate().pipe(Effect.asVoid)
              }),
            ),
            Effect.ignore,
          ),
        )
      }
      return result
    })

    const runCommand = (command: ChildProcess.Command, options?: RunOptions) => {
      const description = describeCommand(command)
      const collect = Effect.scoped(
        Effect.gen(function* () {
          const handle = yield* spawnProcess(command)
          const [stdout, stderr, exitCode] = yield* Effect.all(
            [
              collectStream(handle.stdout, options?.maxOutputBytes),
              collectStream(handle.stderr, options?.maxErrorBytes),
              handle.exitCode,
            ],
            { concurrency: "unbounded" },
          )
          return {
            command: description,
            exitCode,
            stdout: stdout.buffer,
            stderr: stderr.buffer,
            stdoutTruncated: stdout.truncated,
            stderrTruncated: stderr.truncated,
          } satisfies RunResult
        }),
      )
      const timed = options?.timeout
        ? Effect.timeoutOrElse(collect, {
            duration: options.timeout,
            orElse: () => Effect.fail(new AppProcessError({ command: description, cause: new Error("Timed out") })),
          })
        : collect
      const aborted = options?.signal
        ? timed.pipe(
            Effect.raceFirst(
              waitForAbort(options.signal).pipe(Effect.mapError((cause) => wrapError(description, cause))),
            ),
          )
        : timed
      return aborted.pipe(Effect.catch((cause) => Effect.fail(wrapError(description, cause))))
    }

    const run = Effect.fn("AppProcess.run")(function* (input: ProcessInput, options?: RunOptions) {
      const normalized = normalizeInput(input)
      const command = normalized.command
      const effectiveOptions = {
        ...options,
        ...(options?.timeout === undefined && normalized.timeout !== undefined ? { timeout: normalized.timeout } : {}),
      }
      if (effectiveOptions.stdin === undefined) return yield* runCommand(command, effectiveOptions)
      if (command._tag !== "StandardCommand") {
        return yield* new AppProcessError({
          command: describeCommand(command),
          cause: new Error("stdin option only supports StandardCommand; received PipedCommand"),
        })
      }
      const next = ChildProcess.make(command.command, command.args, {
        ...command.options,
        stdin: normalizeStdin(effectiveOptions.stdin),
      })
      return yield* runCommand(next, effectiveOptions)
    })

    const runStream = (
      input: ProcessInput,
      options?: RunStreamOptions,
    ): Stream.Stream<string, AppProcessError> => {
      const normalized = normalizeInput(input)
      const command = normalized.command
      const description = describeCommand(command)
      const okExitCodes = options?.okExitCodes
      const built: Stream.Stream<string, AppProcessError | PlatformError> = Stream.unwrap(
        Effect.gen(function* () {
          const handle = yield* spawnProcess(input)
          const stderrFiber = yield* Effect.forkScoped(
            collectStream(handle.stderr, options?.maxErrorBytes).pipe(Effect.map((x) => x.buffer.toString("utf8"))),
          )
          const source = options?.includeStderr === true ? handle.all : handle.stdout
          const lines = source.pipe(
            Stream.decodeText,
            Stream.splitLines,
            Stream.filter((line) => line.length > 0),
          )
          const tail = Stream.unwrap(
            Effect.gen(function* () {
              const code = yield* handle.exitCode
              if (okExitCodes && okExitCodes.length > 0 && !okExitCodes.includes(code)) {
                const stderr = yield* Fiber.join(stderrFiber)
                return Stream.fail(new AppProcessError({ command: description, exitCode: code, stderr }))
              }
              return Stream.empty
            }),
          )
          return Stream.concat(lines, tail) as Stream.Stream<string, AppProcessError | PlatformError>
        }),
      )
      const mapped = built.pipe(
        Stream.catch((cause): Stream.Stream<string, AppProcessError> => Stream.fail(wrapError(description, cause))),
      )
      let bounded = mapped
      if (options?.signal) {
        bounded = bounded.pipe(
          Stream.interruptWhen(
            waitForAbort(options.signal).pipe(Effect.mapError((cause) => wrapError(description, cause))),
          ),
        )
      }
      const timeout = options?.timeout ?? normalized.timeout
      if (timeout !== undefined) {
        bounded = bounded.pipe(
          Stream.interruptWhen(
            Effect.sleep(timeout).pipe(
              Effect.flatMap(() => Effect.fail(new AppProcessError({ command: description, cause: new Error("Timed out") }))),
            ),
          ),
        )
      }
      return bounded
    }

    return Service.of({ ...spawner, spawn: spawnProcess, run, runStream })
  }),
)

export const defaultLayer = layer.pipe(Layer.provide(CrossSpawnSpawner.defaultLayer))

export * as AppProcess from "./process"
