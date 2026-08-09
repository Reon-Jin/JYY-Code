import { Identifier } from "@/id/id"
import { Cause, Context, Effect, Exit, Fiber, Layer, Scope, Stream, SynchronizedRef } from "effect"
import { ChildProcess } from "effect/unstable/process"
import { ChildProcessSpawner, type ChildProcessHandle } from "effect/unstable/process/ChildProcessSpawner"
import { CrossSpawnSpawner } from "@jyycode-ai/core/cross-spawn-spawner"
import * as Truncate from "@/tool/truncate"
import { budgetFor } from "@/execution/budget"

export type Status = "running" | "completed" | "error" | "cancelled" | "timed_out" | "kill_failed"

export type Info = {
  id: string
  command: string
  cwd: string
  title?: string
  status: Status
  started_at: number
  owner_session_id?: string
  deadline_at?: number
  completed_at?: number
  exit?: number | null
  termination_reason?: string
  outputPath?: string
  truncated?: boolean
}

type Active = {
  info: Info
  handle?: ChildProcessHandle
  chunks: string[]
  bytes: number
  watchdog?: Fiber.Fiber<void, unknown>
  terminationRequested?: "cancelled" | "timed_out"
}

type FinishUpdate = {
  info?: Info
  watchdog?: Fiber.Fiber<void, unknown>
}

export type StartInput = {
  command: ChildProcess.Command
  rawCommand: string
  cwd: string
  env: NodeJS.ProcessEnv
  title?: string
  owner_session_id?: string
  timeout?: number
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
  readonly cancelOwner: (ownerSessionId: string) => Effect.Effect<ReadonlyArray<Info>>
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
      data: { exit?: number | null; termination_reason?: string } = {},
      stopWatchdog = true,
    ) {
      const completed_at = Date.now()
      const result = yield* SynchronizedRef.modify(processes, (items): readonly [FinishUpdate, Map<string, Active>] => {
        const active = items.get(id)
        if (!active) return [{ info: undefined, watchdog: undefined }, items] as const
        if (
          (status === "completed" || status === "error") &&
          (active.terminationRequested !== undefined || active.info.status !== "running")
        ) {
          return [{ info: snapshot(active), watchdog: undefined }, items] as const
        }
        const next: Active = {
          ...active,
          handle: status === "kill_failed" ? active.handle : undefined,
          watchdog: status === "kill_failed" ? undefined : active.watchdog,
          terminationRequested: undefined,
          info: {
            ...active.info,
            status,
            completed_at,
            ...(data.exit !== undefined ? { exit: data.exit } : {}),
            ...(data.termination_reason ? { termination_reason: data.termination_reason } : {}),
          },
        }
        return [{ info: snapshot(next), watchdog: stopWatchdog ? active.watchdog : undefined }, new Map(items).set(id, next)] as const
      })
      if (result?.watchdog) yield* Fiber.interrupt(result.watchdog).pipe(Effect.ignore)
      return result?.info
    })

    const finish = Effect.fn("BackgroundProcess.finish")(function* (
      id: string,
      status: Exclude<Status, "running">,
      data: { exit?: number | null; termination_reason?: string } = {},
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

    const terminate = Effect.fn("BackgroundProcess.terminate")(function* (
      id: string,
      successStatus: "cancelled" | "timed_out",
      reason: string,
      forceAfterMs: number,
    ) {
      const active = (yield* SynchronizedRef.get(processes)).get(id)
      if (!active?.handle || (active.info.status !== "running" && active.info.status !== "kill_failed")) {
        return active ? snapshot(active) : undefined
      }
      yield* SynchronizedRef.update(processes, (items) => {
        const current = items.get(id)
        if (!current || !current.handle) return items
        return new Map(items).set(id, { ...current, terminationRequested: successStatus })
      })
      const forceAfter = Math.max(forceAfterMs, 50)
      const result = yield* Effect.exit(
        active.handle.kill({ forceKillAfter: `${forceAfter} millis` }).pipe(
          Effect.timeout(`${Math.max(forceAfter * 2, 100)} millis`),
        ),
      )
      if (Exit.isSuccess(result)) {
        return yield* finish(id, successStatus, { termination_reason: reason })
      }
      const detail = Cause.squash(result.cause)
      return yield* finishRef(
        processes,
        id,
        "kill_failed",
        { termination_reason: `${reason}: ${detail instanceof Error ? detail.message : String(detail)}` },
        false,
      )
    })

    const start: Interface["start"] = Effect.fn("BackgroundProcess.start")(function* (input) {
      const id = Identifier.ascending("proc")
      const limits = yield* trunc.limits()
      const budget = budgetFor("background_process", input.timeout)
      const handle = yield* spawner.spawn(input.command).pipe(Effect.orDie, Effect.provideService(Scope.Scope, scope))
      const started_at = Date.now()
      const info: Info = {
        id,
        command: input.rawCommand,
        cwd: input.cwd,
        title: input.title,
        status: "running",
        started_at,
        owner_session_id: input.owner_session_id,
        deadline_at: started_at + budget.effectiveMs,
      }

      yield* SynchronizedRef.update(processes, (items) =>
        new Map(items).set(id, { info, handle, chunks: [], bytes: 0 }),
      )

      yield* Stream.runForEach(Stream.decodeText(handle.all), (chunk) => appendRef(processes, limits, id, chunk)).pipe(
        Effect.catchCause(() => Effect.void),
        Effect.forkIn(scope, { startImmediately: true }),
      )
      yield* handle.exitCode.pipe(
        Effect.flatMap((exit) => finishRef(processes, id, exit === 0 ? "completed" : "error", { exit }, true)),
        Effect.catch(() => finishRef(processes, id, "error", { exit: null })),
        Effect.catchCause(() => Effect.void),
        Effect.forkIn(scope, { startImmediately: true }),
      )

      const watchdog = yield* Effect.sleep(`${budget.effectiveMs} millis`).pipe(
        Effect.flatMap(() => terminate(id, "timed_out", "deadline_exceeded", budget.graceMs)),
        Effect.catchCause(() => Effect.void),
        Effect.asVoid,
        Effect.forkIn(scope, { startImmediately: true }),
      )
      yield* SynchronizedRef.update(processes, (items) => {
        const active = items.get(id)
        if (!active || active.info.status !== "running") return items
        return new Map(items).set(id, { ...active, watchdog })
      })

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
      return yield* terminate(input.id, "cancelled", "user_requested", input.forceAfterMs ?? 3000)
    })

    const cancelOwner: Interface["cancelOwner"] = Effect.fn("BackgroundProcess.cancelOwner")(function* (ownerSessionId) {
      const items = yield* SynchronizedRef.get(processes)
      const ids = Array.from(items.values())
        .filter(
          (active) =>
            active.info.owner_session_id === ownerSessionId &&
            (active.info.status === "running" || active.info.status === "kill_failed"),
        )
        .map((active) => active.info.id)
      const results = yield* Effect.forEach(ids, (id) => terminate(id, "cancelled", "session_cancelled", 3000), {
        concurrency: "unbounded",
      })
      return results.filter((info): info is Info => info !== undefined)
    })

    return Service.of({ start, get, output, kill, cancelOwner })
  }),
)

export const defaultLayer = layer.pipe(
  Layer.provide(CrossSpawnSpawner.defaultLayer),
  Layer.provide(Truncate.defaultLayer),
)
export * as BackgroundProcess from "./job"
