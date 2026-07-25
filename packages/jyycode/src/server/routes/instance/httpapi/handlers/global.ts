import { Config } from "@/config/config"
import { GlobalBus, type GlobalEvent as GlobalBusEvent } from "@/bus/global"
import { EffectBridge } from "@/effect/bridge"
import { Bus } from "@/bus"
import { Installation } from "@/installation"
import { disposeAllInstancesAndEmitGlobalDisposed } from "@/server/global-lifecycle"
import { InstallationVersion } from "@jyycode-ai/core/installation/version"
import { Global } from "@jyycode-ai/core/global"
import * as Log from "@jyycode-ai/core/util/log"
import { Effect, Queue, Schema } from "effect"
import * as Stream from "effect/Stream"
import { HttpServerRequest, HttpServerResponse } from "effect/unstable/http"
import { HttpApiBuilder } from "effect/unstable/httpapi"
import * as Sse from "effect/unstable/encoding/Sse"
import { RootHttpApi } from "../api"
import { GlobalCompaction, GlobalDefaultPermissionUpdate, GlobalUpgradeInput } from "../groups/global"
import { isDeepStrictEqual } from "node:util"
import { MemoryManagement } from "@/memory/management"
import {
  GlobalMemoryBadRequestError,
  GlobalMemoryConflictError,
  GlobalMemoryEntryInput,
  GlobalMemoryExport,
  GlobalMemoryListQuery,
  GlobalMemoryNotFoundError,
  GlobalMemoryOperationQuery,
  GlobalMemoryParams,
  GlobalMemoryScopeParams,
} from "../groups/global"

const log = Log.create({ service: "server" })

type CompactionConfig = (typeof Config.Info.Type)["compaction"]

function globalCompaction(value: CompactionConfig): typeof GlobalCompaction.Type {
  return {
    auto: value?.auto ?? true,
    prune: value?.prune ?? true,
    tailTurns: value?.tail_turns ?? 2,
    ...(value?.preserve_recent_tokens === undefined ? {} : { preserveRecentTokens: value.preserve_recent_tokens }),
    ...(value?.reserved === undefined ? {} : { reservedTokens: value.reserved }),
    triggerRatio: value?.trigger_ratio ?? 0.92,
    microCompact: value?.micro_compact ?? true,
    microCompactMaxChars: value?.micro_compact_max_chars ?? 8000,
    reactiveCompact: value?.reactive_compact ?? true,
  }
}

function compactionConfig(value: typeof GlobalCompaction.Type): NonNullable<CompactionConfig> {
  return {
    auto: value.auto,
    prune: value.prune,
    tail_turns: value.tailTurns,
    ...(value.preserveRecentTokens === undefined ? {} : { preserve_recent_tokens: value.preserveRecentTokens }),
    ...(value.reservedTokens === undefined ? {} : { reserved: value.reservedTokens }),
    trigger_ratio: value.triggerRatio,
    micro_compact: value.microCompact,
    micro_compact_max_chars: value.microCompactMaxChars,
    reactive_compact: value.reactiveCompact,
  }
}

function eventData(data: unknown): Sse.Event {
  return {
    _tag: "Event",
    event: "message",
    id: undefined,
    data: JSON.stringify(data),
  }
}

function parseBody(body: string) {
  try {
    return JSON.parse(body || "{}") as unknown
  } catch {
    return undefined
  }
}

function memoryApiError(error: Error) {
  if (/not found|missing|stale/iu.test(error.message)) {
    return new GlobalMemoryNotFoundError({ message: "Memory entry was not found or has changed" })
  }
  if (/already exists|conflict/iu.test(error.message)) {
    return new GlobalMemoryConflictError({ message: "Memory entry conflicts with an existing entry" })
  }
  return new GlobalMemoryBadRequestError({ message: "Invalid memory management request" })
}

function mapMemoryError<A>(effect: Effect.Effect<A, Error>) {
  return effect.pipe(Effect.mapError(memoryApiError))
}

function eventResponse() {
  log.info("global event connected")
  const events = Stream.callback<GlobalBusEvent>((queue) => {
    const handler = (event: GlobalBusEvent) => Queue.offerUnsafe(queue, event)
    return Effect.acquireRelease(
      Effect.sync(() => GlobalBus.on("event", handler)),
      () => Effect.sync(() => GlobalBus.off("event", handler)),
    )
  })
  const heartbeat = Stream.tick("10 seconds").pipe(
    Stream.drop(1),
    Stream.map(() => ({ payload: { id: Bus.createID(), type: "server.heartbeat", properties: {} } })),
  )

  return HttpServerResponse.stream(
    Stream.make({ payload: { id: Bus.createID(), type: "server.connected", properties: {} } }).pipe(
      Stream.concat(events.pipe(Stream.merge(heartbeat, { haltStrategy: "left" }))),
      Stream.map(eventData),
      Stream.pipeThroughChannel(Sse.encode()),
      Stream.encodeText,
      Stream.ensuring(Effect.sync(() => log.info("global event disconnected"))),
    ),
    {
      contentType: "text/event-stream",
      headers: {
        "Cache-Control": "no-cache, no-transform",
        "X-Accel-Buffering": "no",
        "X-Content-Type-Options": "nosniff",
      },
    },
  )
}

export const globalHandlers = HttpApiBuilder.group(RootHttpApi, "global", (handlers) =>
  Effect.gen(function* () {
    const config = yield* Config.Service
    const installation = yield* Installation.Service
    const global = yield* Global.Service
    const memory = yield* MemoryManagement.Service
    const bridge = yield* EffectBridge.make()

    const health = Effect.fn("GlobalHttpApi.health")(function* () {
      return { healthy: true as const, version: InstallationVersion }
    })

    const event = Effect.fn("GlobalHttpApi.event")(function* () {
      return eventResponse()
    })

    const configGet = Effect.fn("GlobalHttpApi.configGet")(function* () {
      return yield* config.getGlobal()
    })

    const managementContext = Effect.fn("GlobalHttpApi.managementContext")(function* () {
      return { directory: global.home }
    })

    const defaultPermissionGet = Effect.fn("GlobalHttpApi.defaultPermissionGet")(function* () {
      const permission = (yield* config.getGlobal()).permission
      if (permission === undefined) return { mode: "auto" as const }
      if (isDeepStrictEqual(permission, { "*": "ask" })) return { mode: "request" as const }
      if (isDeepStrictEqual(permission, { "*": "allow" })) return { mode: "full" as const }
      return { mode: "custom" as const }
    })

    const defaultPermissionUpdate = Effect.fn("GlobalHttpApi.defaultPermissionUpdate")(function* (ctx: {
      payload: typeof GlobalDefaultPermissionUpdate.Type
    }) {
      const value =
        ctx.payload.mode === "auto"
          ? undefined
          : { "*": ctx.payload.mode === "request" ? ("ask" as const) : ("allow" as const) }
      const result = yield* config.updateGlobalPath(["permission"], value)
      if (result.changed) bridge.fork(disposeAllInstancesAndEmitGlobalDisposed({ swallowErrors: true }))
      return { mode: ctx.payload.mode }
    })

    const compactionGet = Effect.fn("GlobalHttpApi.compactionGet")(function* () {
      return globalCompaction((yield* config.getGlobal()).compaction)
    })

    const compactionUpdate = Effect.fn("GlobalHttpApi.compactionUpdate")(function* (ctx: {
      payload: typeof GlobalCompaction.Type
    }) {
      const result = yield* config.updateGlobalPath(["compaction"], compactionConfig(ctx.payload))
      if (result.changed) bridge.fork(disposeAllInstancesAndEmitGlobalDisposed({ swallowErrors: true }))
      return globalCompaction(result.info.compaction)
    })

    const compactionReset = Effect.fn("GlobalHttpApi.compactionReset")(function* () {
      const result = yield* config.updateGlobalPath(["compaction"], undefined)
      if (result.changed) bridge.fork(disposeAllInstancesAndEmitGlobalDisposed({ swallowErrors: true }))
      return globalCompaction(result.info.compaction)
    })

    const memoryList = Effect.fn("GlobalHttpApi.memoryList")(function* (ctx: {
      query: typeof GlobalMemoryListQuery.Type
    }) {
      return yield* mapMemoryError(memory.list(ctx.query))
    })

    const memoryUserCreate = Effect.fn("GlobalHttpApi.memoryUserCreate")(function* (ctx: {
      payload: typeof GlobalMemoryEntryInput.Type
    }) {
      return yield* mapMemoryError(memory.createUser(ctx.payload))
    })

    const memoryUpdate = Effect.fn("GlobalHttpApi.memoryUpdate")(function* (ctx: {
      params: { scope: typeof GlobalMemoryParams.scope.Type; id: string }
      query: typeof GlobalMemoryOperationQuery.Type
      payload: typeof GlobalMemoryEntryInput.Type
    }) {
      const input =
        ctx.params.scope === "task"
          ? { scope: "task" as const, id: ctx.params.id, sessionID: ctx.query.sessionID!, ...ctx.payload }
          : { scope: "user" as const, id: ctx.params.id, ...ctx.payload }
      if (ctx.params.scope === "task" && !ctx.query.sessionID) {
        return yield* new GlobalMemoryBadRequestError({ message: "Task memory requires a sessionID" })
      }
      return yield* mapMemoryError(memory.update(input))
    })

    const memoryRemove = Effect.fn("GlobalHttpApi.memoryRemove")(function* (ctx: {
      params: { scope: typeof GlobalMemoryParams.scope.Type; id: string }
      query: typeof GlobalMemoryOperationQuery.Type
    }) {
      if (ctx.params.scope === "task" && !ctx.query.sessionID) {
        return yield* new GlobalMemoryBadRequestError({ message: "Task memory requires a sessionID" })
      }
      yield* mapMemoryError(
        memory.remove({ scope: ctx.params.scope, id: ctx.params.id, sessionID: ctx.query.sessionID }),
      )
      return { removed: true }
    })

    const memoryCompact = Effect.fn("GlobalHttpApi.memoryCompact")(function* (ctx: {
      params: { scope: typeof GlobalMemoryScopeParams.scope.Type }
      query: typeof GlobalMemoryOperationQuery.Type
    }) {
      const result = yield* mapMemoryError(memory.compact({ scope: ctx.params.scope, sessionID: ctx.query.sessionID }))
      return { removed: result.removed, merged: result.merged, retained: result.retained }
    })

    const memoryTaskClear = Effect.fn("GlobalHttpApi.memoryTaskClear")(function* (ctx: {
      query: typeof GlobalMemoryOperationQuery.Type
    }) {
      return { removed: yield* mapMemoryError(memory.clearTask({ sessionID: ctx.query.sessionID })) }
    })

    const memoryExport = Effect.fn("GlobalHttpApi.memoryExport")(function* (ctx: {
      query: typeof GlobalMemoryListQuery.Type
    }) {
      const text = yield* mapMemoryError(memory.exportStore({ scope: ctx.query.scope, sessionID: ctx.query.sessionID }))
      return yield* Schema.decodeUnknownEffect(GlobalMemoryExport)(JSON.parse(text)).pipe(Effect.orDie)
    })

    const configUpdate = Effect.fn("GlobalHttpApi.configUpdate")(function* (ctx) {
      const result = yield* config.updateGlobal(ctx.payload)
      if (result.changed) bridge.fork(disposeAllInstancesAndEmitGlobalDisposed({ swallowErrors: true }))
      return result.info
    })

    const dispose = Effect.fn("GlobalHttpApi.dispose")(function* () {
      yield* disposeAllInstancesAndEmitGlobalDisposed()
      return true
    })

    const upgrade = Effect.fn("GlobalHttpApi.upgrade")(function* (ctx: { payload: typeof GlobalUpgradeInput.Type }) {
      const method = yield* installation.method()
      if (method === "unknown") {
        return {
          status: 400,
          body: { success: false as const, error: "Unknown installation method" },
        }
      }
      const target = ctx.payload.target || (yield* installation.latest(method))
      const result = yield* installation.upgrade(method, target).pipe(
        Effect.as({ status: 200, body: { success: true as const, version: target } }),
        Effect.catch((err) =>
          Effect.succeed({
            status: 500,
            body: {
              success: false as const,
              error: err instanceof Error ? err.message : String(err),
            },
          }),
        ),
      )
      if (!result.body.success) return result
      GlobalBus.emit("event", {
        directory: "global",
        payload: {
          type: Installation.Event.Updated.type,
          properties: { version: target },
        },
      })
      return result
    })

    const upgradeRaw = Effect.fn("GlobalHttpApi.upgradeRaw")(function* (ctx: {
      request: HttpServerRequest.HttpServerRequest
    }) {
      const body = yield* Effect.orDie(ctx.request.text)
      const json = parseBody(body)
      if (json === undefined) {
        return HttpServerResponse.jsonUnsafe({ success: false, error: "Invalid request body" }, { status: 400 })
      }
      const payload = yield* Schema.decodeUnknownEffect(GlobalUpgradeInput)(json).pipe(
        Effect.map((payload) => ({ valid: true as const, payload })),
        Effect.catch(() => Effect.succeed({ valid: false as const })),
      )
      if (!payload.valid) {
        return HttpServerResponse.jsonUnsafe({ success: false, error: "Invalid request body" }, { status: 400 })
      }
      const result = yield* upgrade({ payload: payload.payload })
      return HttpServerResponse.jsonUnsafe(result.body, { status: result.status })
    })

    return handlers
      .handle("health", health)
      .handleRaw("event", event)
      .handle("configGet", configGet)
      .handle("managementContext", managementContext)
      .handle("defaultPermissionGet", defaultPermissionGet)
      .handle("defaultPermissionUpdate", defaultPermissionUpdate)
      .handle("compactionGet", compactionGet)
      .handle("compactionUpdate", compactionUpdate)
      .handle("compactionReset", compactionReset)
      .handle("memoryList", memoryList)
      .handle("memoryUserCreate", memoryUserCreate)
      .handle("memoryUpdate", memoryUpdate)
      .handle("memoryRemove", memoryRemove)
      .handle("memoryCompact", memoryCompact)
      .handle("memoryTaskClear", memoryTaskClear)
      .handle("memoryExport", memoryExport)
      .handle("configUpdate", configUpdate)
      .handle("dispose", dispose)
      .handleRaw("upgrade", upgradeRaw)
  }),
)
