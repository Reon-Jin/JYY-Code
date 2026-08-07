import path from "path"
import { Context, Duration, Effect, Layer, Option, Schedule, Schema } from "effect"
import { FetchHttpClient, HttpClient, HttpClientRequest } from "effect/unstable/http"
import { Global } from "./global"
import { Flag } from "./flag/flag"
import { Flock } from "./util/flock"
import { Hash } from "./util/hash"
import { AppFileSystem } from "./filesystem"
import { InstallationChannel, InstallationVersion } from "./installation/version"
import { EventV2 } from "./event"

export const CatalogModelStatus = Schema.Literals(["alpha", "beta", "deprecated"])
export type CatalogModelStatus = typeof CatalogModelStatus.Type

const USER_AGENT = `jyycode/${InstallationChannel}/${InstallationVersion}/${Flag.JYYCODE_CLIENT}`

const CostTier = Schema.Struct({
  input: Schema.Finite,
  output: Schema.Finite,
  cache_read: Schema.optional(Schema.Finite),
  cache_write: Schema.optional(Schema.Finite),
  tier: Schema.Struct({
    type: Schema.Literal("context"),
    size: Schema.Finite,
  }),
})

const Cost = Schema.Struct({
  input: Schema.Finite,
  output: Schema.Finite,
  cache_read: Schema.optional(Schema.Finite),
  cache_write: Schema.optional(Schema.Finite),
  tiers: Schema.optional(Schema.Array(CostTier)),
  context_over_200k: Schema.optional(
    Schema.Struct({
      input: Schema.Finite,
      output: Schema.Finite,
      cache_read: Schema.optional(Schema.Finite),
      cache_write: Schema.optional(Schema.Finite),
    }),
  ),
})

export const Model = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  family: Schema.optional(Schema.String),
  release_date: Schema.String,
  attachment: Schema.Boolean,
  reasoning: Schema.Boolean,
  temperature: Schema.Boolean,
  tool_call: Schema.Boolean,
  interleaved: Schema.optional(
    Schema.Union([
      Schema.Literal(true),
      Schema.Struct({
        field: Schema.Literals(["reasoning_content", "reasoning_details"]),
      }),
    ]),
  ),
  cost: Schema.optional(Cost),
  limit: Schema.Struct({
    context: Schema.Finite,
    input: Schema.optional(Schema.Finite),
    output: Schema.Finite,
  }),
  modalities: Schema.optional(
    Schema.Struct({
      input: Schema.Array(Schema.Literals(["text", "audio", "image", "video", "pdf"])),
      output: Schema.Array(Schema.Literals(["text", "audio", "image", "video", "pdf"])),
    }),
  ),
  experimental: Schema.optional(
    Schema.Struct({
      modes: Schema.optional(
        Schema.Record(
          Schema.String,
          Schema.Struct({
            cost: Schema.optional(Cost),
            provider: Schema.optional(
              Schema.Struct({
                body: Schema.optional(Schema.Record(Schema.String, Schema.MutableJson)),
                headers: Schema.optional(Schema.Record(Schema.String, Schema.String)),
              }),
            ),
          }),
        ),
      ),
    }),
  ),
  status: Schema.optional(CatalogModelStatus),
  provider: Schema.optional(
    Schema.Struct({ npm: Schema.optional(Schema.String), api: Schema.optional(Schema.String) }),
  ),
})
export type Model = Schema.Schema.Type<typeof Model>

export const Provider = Schema.Struct({
  api: Schema.optional(Schema.String),
  name: Schema.String,
  env: Schema.Array(Schema.String),
  id: Schema.String,
  npm: Schema.optional(Schema.String),
  models: Schema.Record(Schema.String, Model),
})

export type Provider = Schema.Schema.Type<typeof Provider>

// Providers bundled with JYYCode that are not (yet) present in the models.dev
// catalog. They are merged into every catalog read so the CLI provider service,
// `/connect`, and the v2 catalog all see them. Once models.dev publishes an
// entry with the same id, that entry wins and this snapshot is ignored.
export const BuiltinProviders: Record<string, Provider> = {
  agnes: {
    id: "agnes",
    name: "Agnes AI",
    env: ["AGNES_API_KEY"],
    npm: "@ai-sdk/openai-compatible",
    // China service node; international keys should use https://apihub.agnes-ai.com/v1
    api: "https://api.agnes-ai.cn/v1",
    models: {
      "agnes-2.5-flash": {
        id: "agnes-2.5-flash",
        name: "Agnes 2.5 Flash",
        family: "agnes",
        release_date: "2026-07-10",
        attachment: true,
        reasoning: true,
        temperature: true,
        tool_call: true,
        limit: { context: 524288, output: 65536 },
        modalities: { input: ["text", "image"], output: ["text"] },
        cost: { input: 0, output: 0 },
      },
      "agnes-2.0-flash": {
        id: "agnes-2.0-flash",
        name: "Agnes 2.0 Flash",
        family: "agnes",
        release_date: "2026-05-26",
        attachment: true,
        reasoning: true,
        temperature: true,
        tool_call: true,
        limit: { context: 524288, output: 65536 },
        modalities: { input: ["text", "image"], output: ["text"] },
        cost: { input: 0, output: 0 },
      },
      "agnes-2.5-pro-alpha": {
        id: "agnes-2.5-pro-alpha",
        name: "Agnes 2.5 Pro Alpha",
        family: "agnes",
        release_date: "2026-07-24",
        attachment: true,
        reasoning: true,
        temperature: true,
        tool_call: true,
        limit: { context: 1048576, output: 65536 },
        modalities: { input: ["text", "image"], output: ["text"] },
        cost: { input: 0.45, output: 0.9, cache_read: 0.0038 },
      },
    },
  },
}

function withBuiltins(data: Record<string, Provider>): Record<string, Provider> {
  const result = { ...data }
  for (const [id, provider] of Object.entries(BuiltinProviders)) {
    if (!result[id]) result[id] = provider
  }
  return result
}

export const Event = {
  Refreshed: EventV2.define({
    type: "models-dev.refreshed",
    schema: {},
  }),
}

declare const JYYCODE_MODELS_DEV: Record<string, Provider> | undefined

export interface Interface {
  readonly get: () => Effect.Effect<Record<string, Provider>>
  readonly refresh: (force?: boolean) => Effect.Effect<void>
}

export class Service extends Context.Service<Service, Interface>()("@jyycode/ModelsDev") {}

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const fs = yield* AppFileSystem.Service
    const events = yield* EventV2.Service
    const http = HttpClient.filterStatusOk(
      (yield* HttpClient.HttpClient).pipe(
        HttpClient.retryTransient({
          retryOn: "errors-and-responses",
          times: 2,
          schedule: Schedule.exponential(200).pipe(Schedule.jittered),
        }),
      ),
    )

    const source = Flag.JYYCODE_MODELS_URL || "https://models.dev"
    const filepath = path.join(
      Global.Path.cache,
      source === "https://models.dev" ? "models.json" : `models-${Hash.fast(source)}.json`,
    )
    const ttl = Duration.minutes(5)
    const lockKey = `models-dev:${filepath}`

    const fresh = Effect.fnUntraced(function* () {
      const stat = yield* fs.stat(filepath).pipe(Effect.catch(() => Effect.succeed(undefined)))
      if (!stat) return false
      const mtime = Option.getOrElse(stat.mtime, () => new Date(0)).getTime()
      return Date.now() - mtime < Duration.toMillis(ttl)
    })

    const fetchApi = Effect.fn("ModelsDev.fetchApi")(function* () {
      return yield* HttpClientRequest.get(`${source}/api.json`).pipe(
        HttpClientRequest.setHeader("User-Agent", USER_AGENT),
        http.execute,
        Effect.flatMap((res) => res.text),
        Effect.timeout("10 seconds"),
      )
    })

    const loadFromDisk = fs.readJson(Flag.JYYCODE_MODELS_PATH ?? filepath).pipe(
      Effect.catch(() => Effect.succeed(undefined)),
      Effect.map((v) => v as Record<string, Provider> | undefined),
    )

    const loadSnapshot = Effect.sync(() => (typeof JYYCODE_MODELS_DEV === "undefined" ? undefined : JYYCODE_MODELS_DEV))

    const fetchAndWrite = Effect.fn("ModelsDev.fetchAndWrite")(function* () {
      const text = yield* fetchApi()
      yield* fs.writeWithDirs(filepath, text)
      return text
    })

    const populate = Effect.gen(function* () {
      const fromDisk = yield* loadFromDisk
      if (fromDisk) return withBuiltins(fromDisk)
      const snapshot = yield* loadSnapshot
      if (snapshot) return withBuiltins(snapshot)
      if (Flag.JYYCODE_DISABLE_MODELS_FETCH) return withBuiltins({})
      // Flock is cross-process: concurrent jyycode CLIs can race on this cache file.
      const text = yield* Effect.scoped(
        Effect.gen(function* () {
          yield* Flock.effect(lockKey)
          return yield* fetchAndWrite()
        }),
      )
      return withBuiltins(JSON.parse(text) as Record<string, Provider>)
    }).pipe(Effect.withSpan("ModelsDev.populate"), Effect.orDie)

    const [cachedGet, invalidate] = yield* Effect.cachedInvalidateWithTTL(populate, Duration.infinity)

    const get = (): Effect.Effect<Record<string, Provider>> => cachedGet

    const refresh = Effect.fn("ModelsDev.refresh")(function* (force = false) {
      if (!force && (yield* fresh())) return
      yield* Effect.scoped(
        Effect.gen(function* () {
          yield* Flock.effect(lockKey)
          // Re-check under the lock: another process may have refreshed between
          // our outer check and lock acquisition.
          if (!force && (yield* fresh())) return
          yield* fetchAndWrite()
          yield* invalidate
          yield* events.publish(Event.Refreshed, {})
        }),
      ).pipe(
        Effect.tapCause((cause) =>
          Effect.logError("Failed to fetch models.dev").pipe(Effect.annotateLogs("cause", cause)),
        ),
        Effect.ignore,
      )
    })

    if (!Flag.JYYCODE_DISABLE_MODELS_FETCH && !process.argv.includes("--get-yargs-completions")) {
      // Schedule.spaced runs the effect once, then waits between completions.
      yield* Effect.forkScoped(refresh().pipe(Effect.repeat(Schedule.spaced("60 minutes")), Effect.ignore))
    }

    return Service.of({ get, refresh })
  }),
)

export const defaultLayer = layer.pipe(
  Layer.provide(FetchHttpClient.layer),
  Layer.provide(AppFileSystem.defaultLayer),
  Layer.provide(EventV2.defaultLayer),
)

export * as ModelsDev from "./models-dev"
