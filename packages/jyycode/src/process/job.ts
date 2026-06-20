import { Identifier } from "@/id/id"
import { Context, Effect, Layer, Scope, Stream, SynchronizedRef } from "effect"
import { ChildProcess } from "effect/unstable/process"
import { ChildProcessSpawner, type ChildProcessHandle } from "effect/unstable/process/ChildProcessSpawner"
import { CrossSpawnSpawner } from "@jyycode-ai/core/cross-spawn-spawner"
import * as Truncate from "@/tool/truncate"

export type Status = "running" | "completed" | "error" | "cancelled"

export type Info = {
  id: string
  command: string
  cwd: string
  title?: string
  status: Status
  started_at: number
  completed_at?: number
  exit?: number | null
  outputPath?: string
  truncated?: boolean
}

type Active = {
  info: Info
  handle?: ChildProcessHandle
  chunks: string[]
  bytes: number
}

export type StartInput = {
  command: ChildProcess.Command
  rawCommand: string
  cwd: string
  env: NodeJS.ProcessEnv
  title?: string
}

export type OutputInput = {
  id: string
  offset?: number
  limit?: number
}

export type OutputResult = {
  info?: Info
  output: string
}

export type KillInput = {
  id: string
  forceAfterMs?: number
}

export interface Interface {
  readonly start: (input: StartInput) => Effect.Effect<Info>
  readonly get: (id: string) => Effect.Effect<Info | undefined>
  readonly output: (input: OutputInput) => Effect.Effect<OutputResult>
  readonly kill: (input: KillInput) => Effect.Effect<Info | undefined>
}

export class Service extends Context.Service<Service, Interface>()("@jyycode/BackgroundProcess") {}

function snapshot(active: Active): Info {
  return { ...active.info }
}

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const spawner = yield* ChildProcessSpawner
    const trunc = yield* Truncate.Service
    const processes = yield* SynchronizedRef.make(new Map<string, Active>())
    const scope = yield* Scope.Scope

    const finishRef = Effect.fn("BackgroundProcess.finishRef")(function* (
      processes: SynchronizedRef.SynchronizedRef<Map<string, Active>>,
      id: string,
      status: Exclude<Status, "running">,
      data: { exit?: number | null } = {},
    ) {
      const completed_at = Date.now()
      return yield* SynchronizedRef.modify(processes, (items) => {
        const active = items.get(id)
        if (!active) return [undefined, items] as const
        const next: Active = {
          ...active,
          handle: undefined,
          info: { ...active.info, status, completed_at, exit: data.exit },
        }
        return [snapshot(next), new Map(items).set(id, next)] as const
      })
    })

    const finish = Effect.fn("BackgroundProcess.finish")(function* (
      id: string,
      status: Exclude<Status, "running">,
      data: { exit?: number | null } = {},
    ) {
      return yield* finishRef(processes, id, status, data)
    })

    const appendRef = Effect.fn("BackgroundProcess.appendRef")(function* (
      processes: SynchronizedRef.SynchronizedRef<Map<string, Active>>,
      limits: { maxBytes: number },
      id: string,
      text: string,
    ) {
      return yield* SynchronizedRef.updateEffect(
        processes,
        Effect.fnUntraced(function* (items) {
          const active = items.get(id)
          if (!active) return items
          const chunks = [...active.chunks, text]
          let bytes = active.bytes + Buffer.byteLength(text, "utf-8")
          let truncated = active.info.truncated ?? false
          let outputPath = active.info.outputPath
          while (bytes > limits.maxBytes * 2 && chunks.length > 1) {
            const removed = chunks.shift()
            if (!removed) break
            outputPath ??= yield* trunc.write(active.chunks.join(""))
            bytes -= Buffer.byteLength(removed, "utf-8")
            truncated = true
          }
          return new Map(items).set(id, {
            ...active,
            chunks,
            bytes,
            info: { ...active.info, truncated, ...(outputPath ? { outputPath } : {}) },
          })
        }),
      )
    })

    const append = Effect.fn("BackgroundProcess.append")(function* (id: string, text: string) {
      return yield* appendRef(processes, yield* trunc.limits(), id, text)
    })

    const start: Interface["start"] = Effect.fn("BackgroundProcess.start")(function* (input) {
      const id = Identifier.ascending("proc")
      const limits = yield* trunc.limits()
      const handle = yield* spawner.spawn(input.command).pipe(Effect.orDie, Effect.provideService(Scope.Scope, scope))
      const info: Info = {
        id,
        command: input.rawCommand,
        cwd: input.cwd,
        title: input.title,
        status: "running",
        started_at: Date.now(),
      }

      yield* SynchronizedRef.update(processes, (items) =>
        new Map(items).set(id, { info, handle, chunks: [], bytes: 0 }),
      )

      yield* Stream.runForEach(Stream.decodeText(handle.all), (chunk) => appendRef(processes, limits, id, chunk)).pipe(
        Effect.catchCause(() => Effect.void),
        Effect.forkIn(scope, { startImmediately: true }),
      )
      yield* handle.exitCode.pipe(
        Effect.flatMap((exit) => finishRef(processes, id, exit === 0 ? "completed" : "error", { exit })),
        Effect.catch(() => finishRef(processes, id, "error", { exit: null })),
        Effect.catchCause(() => Effect.void),
        Effect.forkIn(scope, { startImmediately: true }),
      )

      return info
    })

    const get: Interface["get"] = Effect.fn("BackgroundProcess.get")(function* (id) {
      const active = (yield* SynchronizedRef.get(processes)).get(id)
      return active ? snapshot(active) : undefined
    })

    const output: Interface["output"] = Effect.fn("BackgroundProcess.output")(function* (input) {
      const active = (yield* SynchronizedRef.get(processes)).get(input.id)
      if (!active) return { output: "" }
      const text = active.chunks.join("")
      const lines = text.split("\n")
      const limit = input.limit ?? 200
      const start = input.offset ? Math.max(0, input.offset - 1) : Math.max(0, lines.length - limit)
      return {
        info: snapshot(active),
        output: lines.slice(start, start + limit).join("\n"),
      }
    })

    const kill: Interface["kill"] = Effect.fn("BackgroundProcess.kill")(function* (input) {
      const active = (yield* SynchronizedRef.get(processes)).get(input.id)
      if (!active) return undefined
      if (!active.handle || active.info.status !== "running") return snapshot(active)
      yield* active.handle.kill({ forceKillAfter: `${input.forceAfterMs ?? 3000} millis` }).pipe(Effect.ignore)
      yield* active.handle.exitCode.pipe(Effect.timeoutOption("2 seconds"), Effect.ignore)
      return yield* finish(input.id, "cancelled", { exit: null })
    })

    return Service.of({ start, get, output, kill })
  }),
)

export const defaultLayer = layer.pipe(Layer.provide(CrossSpawnSpawner.defaultLayer), Layer.provide(Truncate.defaultLayer))
export * as BackgroundProcess from "./job"
