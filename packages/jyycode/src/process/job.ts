import { Identifier } from "@/id/id"
import { Cause, Context, Effect, Exit, Fiber, Layer, Scope, Stream, SynchronizedRef } from "effect"
import { ChildProcess } from "effect/unstable/process"
import { AppProcess } from "@jyycode-ai/core/process"
import * as Truncate from "@/tool/truncate"
import { budgetFor } from "@/execution/budget"
import { createOutputRetention, type OutputRetention } from "@jyycode-ai/core/output-retention"

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
  bytesSeen?: number
  bytesRetained?: number
  sha256?: string
}

type Active = {
  info: Info
  handle?: AppProcess.AppProcessHandle
  retention: OutputRetention
  outputFiber?: Fiber.Fiber<void, unknown>
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
    const appProcess = yield* AppProcess.Service
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
      const current = (yield* SynchronizedRef.get(processes)).get(id)
      if (current) yield* Effect.promise(() => current.retention.flush())
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
            ...(() => {
              const preview = active.retention.snapshot()
              return {
                truncated: preview.truncated,
                bytesSeen: preview.bytesSeen,
                bytesRetained: preview.bytesRetained,
                sha256: preview.sha256,
                ...(preview.truncated && preview.blobRef ? { outputPath: preview.blobRef } : {}),
              }
            })(),
            ...(data.exit !== undefined ? { exit: data.exit } : {}),
            ...(data.termination_reason ? { termination_reason: data.termination_reason } : {}),
          },
        }
        return [
          { info: snapshot(next), watchdog: stopWatchdog ? active.watchdog : undefined },
          new Map(items).set(id, next),
        ] as const
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
      id: string,
      text: string,
    ) {
      return yield* SynchronizedRef.updateEffect(
        processes,
        Effect.fnUntraced(function* (items) {
          const active = items.get(id)
          if (!active) return items
          yield* Effect.promise(() => active.retention.append(text))
          const preview = active.retention.snapshot()
          return new Map(items).set(id, {
            ...active,
            info: {
              ...active.info,
              truncated: preview.truncated,
              bytesSeen: preview.bytesSeen,
              bytesRetained: preview.bytesRetained,
              sha256: preview.sha256,
            },
          })
        }),
      )
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
      const verifyMs = Math.max(forceAfter * 2, 100)
      // The supervisor may spend the grace interval, issue the escalation
      // signal, and then use the full verification interval. The previous
      // forceAfter*2 timeout could expire before that contract completed.
      const terminationTimeoutMs = forceAfter + verifyMs + 250
      const result = yield* Effect.exit(
        active.handle
          .terminate({
            graceMs: forceAfter,
            verifyMs,
          })
          .pipe(Effect.timeout(`${terminationTimeoutMs} millis`)),
      )
      if (active.outputFiber) yield* Fiber.interrupt(active.outputFiber).pipe(Effect.ignore)
      if (Exit.isSuccess(result) && result.value.state !== "kill_failed") {
        return yield* finish(id, successStatus, { termination_reason: reason })
      }
      const detail = Exit.isSuccess(result)
        ? `remaining process ids: ${result.value.remainingPids.join(", ") || "unknown"}`
        : Cause.squash(result.cause)
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
      const handle = yield* appProcess
        .spawn(input.command)
        .pipe(Effect.orDie, Effect.provideService(Scope.Scope, scope))
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
        new Map(items).set(id, {
          info,
          handle,
          retention: createOutputRetention({
            maxBytes: limits.maxBytes,
            strategy: "head_tail",
            spill: "on_truncate",
            blob: {
              write: (source) => Effect.runPromise(trunc.writeStream(source)).then((ref) => ({ ref })),
            },
          }),
        }),
      )

      const outputFiber = yield* Stream.runForEach(Stream.decodeText(handle.all), (chunk) =>
        appendRef(processes, id, chunk),
      ).pipe(
        Effect.catchCause(() => Effect.void),
        Effect.forkIn(scope, { startImmediately: true }),
      )
      yield* SynchronizedRef.update(processes, (items) => {
        const active = items.get(id)
        return active ? new Map(items).set(id, { ...active, outputFiber }) : items
      })
      yield* handle.exitCode.pipe(
        Effect.flatMap((exit) =>
          Effect.gen(function* () {
            const active = (yield* SynchronizedRef.get(processes)).get(id)
            if (active?.outputFiber) yield* Fiber.join(active.outputFiber).pipe(Effect.catch(() => Effect.void))
            return yield* finishRef(processes, id, exit === 0 ? "completed" : "error", { exit }, true)
          }),
        ),
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
      const text = active.retention.snapshot().preview
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

    const cancelOwner: Interface["cancelOwner"] = Effect.fn("BackgroundProcess.cancelOwner")(
      function* (ownerSessionId) {
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
      },
    )

    return Service.of({ start, get, output, kill, cancelOwner })
  }),
)

export const defaultLayer = layer.pipe(Layer.provide(AppProcess.defaultLayer), Layer.provide(Truncate.defaultLayer))
export * as BackgroundProcess from "./job"
