export * from "drizzle-orm"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { Global } from "@jyycode-ai/core/global"
import * as Log from "@jyycode-ai/core/util/log"
import { NamedError } from "@jyycode-ai/core/util/error"
import path from "path"
import { Flag } from "@jyycode-ai/core/flag/flag"
import { InstallationChannel } from "@jyycode-ai/core/installation/version"
import { EffectBridge } from "@/effect/bridge"
import { Context, Effect, Fiber, ManagedRuntime } from "effect"
import { Database as ScopedDatabase } from "@jyycode-ai/core/database/database"
import { Schema } from "effect"
import { Database as BunSqliteDatabase } from "bun:sqlite"
import { drizzle } from "drizzle-orm/bun-sqlite"

export const NotFoundError = NamedError.create("NotFoundError", {
  message: Schema.String,
})

const log = Log.create({ service: "db" })

type DatabaseFlags = Pick<RuntimeFlags.Info, "disableChannelDb" | "skipMigrations">

const readRuntimeFlags = () =>
  Effect.runSync(RuntimeFlags.Service.useSync((flags) => flags).pipe(Effect.provide(RuntimeFlags.defaultLayer)))

export function getChannelPath(flags: Pick<DatabaseFlags, "disableChannelDb"> = readRuntimeFlags()) {
  if (["latest", "beta", "prod"].includes(InstallationChannel) || flags.disableChannelDb)
    return path.join(Global.Path.data, "jyycode.db")
  const safe = InstallationChannel.replace(/[^a-zA-Z0-9._-]/g, "-")
  return path.join(Global.Path.data, `jyycode-${safe}.db`)
}

export const getPath = (flags?: Pick<DatabaseFlags, "disableChannelDb">) => {
  if (Flag.JYYCODE_DB) {
    if (Flag.JYYCODE_DB === ":memory:" || path.isAbsolute(Flag.JYYCODE_DB)) return Flag.JYYCODE_DB
    return path.join(Global.Path.data, Flag.JYYCODE_DB)
  }
  return getChannelPath(flags)
}

export function describePath(flags: Pick<DatabaseFlags, "disableChannelDb"> = readRuntimeFlags()) {
  return {
    path: getPath(flags),
    channel: InstallationChannel,
    source: Flag.JYYCODE_DB
      ? ("override" as const)
      : flags.disableChannelDb
        ? ("shared" as const)
        : ("channel" as const),
    shared: flags.disableChannelDb || ["latest", "beta", "prod"].includes(InstallationChannel),
  }
}

export type Client = ScopedDatabase.Interface["legacy"]
export type Transaction = Parameters<Parameters<Client["transaction"]>[0]>[0]
export type TxOrDb = Transaction | Client
export const Service = ScopedDatabase.Service

export type EffectClient = ScopedDatabase.Interface["db"]
export type EffectTransaction = Parameters<Parameters<EffectClient["transaction"]>[0]>[0]
export type EffectTxOrDb = EffectTransaction | EffectClient

interface EffectTransactionState {
  readonly tx: EffectTxOrDb
  readonly afterCommit: Array<Effect.Effect<unknown, never, never>>
}

const EffectTransactionRef = Context.Reference<EffectTransactionState | undefined>(
  "@jyycode/storage/EffectDatabaseTransaction",
  { defaultValue: () => undefined },
)

export function query<A, E, R>(callback: (db: EffectTxOrDb) => Effect.Effect<A, E, R>) {
  return Effect.withFiber((fiber) => {
    const active = Context.get(fiber.context, EffectTransactionRef)
    if (active) return callback(active.tx).pipe(Effect.orDie)
    return compatibilityServiceEffect().pipe(
      Effect.flatMap((service) => callback(service.db).pipe(Effect.orDie)),
    )
  })
}

export function withTransaction<A, E, R>(
  callback: (tx: EffectTxOrDb) => Effect.Effect<A, E, R>,
  options?: { behavior?: "deferred" | "immediate" | "exclusive" },
) {
  return Effect.withFiber((fiber) => {
    const active = Context.get(fiber.context, EffectTransactionRef)
    if (active) return callback(active.tx).pipe(Effect.orDie)
    const transact = (service: ScopedDatabase.Interface) =>
      service.db
        .transaction(
          (tx) =>
            Effect.gen(function* () {
              const state: EffectTransactionState = { tx, afterCommit: [] }
              const legacy: TransactionState = { tx: service.legacy, effects: [] }
              const result = yield* callback(tx).pipe(
                Effect.provideService(EffectTransactionRef, state),
                // Legacy synchronous projectors run inside Effect.sync. Provide
                // their transaction context explicitly so they use this same
                // native connection instead of opening a competing SQLite one.
                Effect.provideService(TransactionRef, legacy),
              )
              return { result, effects: state.afterCommit, legacyEffects: legacy.effects }
            }),
          options,
        )
        .pipe(
          Effect.orDie,
          Effect.tap((committed) =>
            Effect.forEach(committed.effects, (pending) => pending.pipe(Effect.orDie), { discard: true }).pipe(
              Effect.andThen(() =>
                Effect.sync(() => {
                  for (const pending of committed.legacyEffects) void pending()
                }),
              ),
            ),
          ),
          Effect.map((committed) => committed.result),
        )
    return compatibilityServiceEffect().pipe(Effect.flatMap(transact))
  })
}

export function afterCommit<A, E>(pending: Effect.Effect<A, E, never>) {
  return Effect.gen(function* () {
    const active = yield* EffectTransactionRef
    if (active) {
      active.afterCommit.push(pending.pipe(Effect.orDie))
      return
    }
    yield* pending
  })
}

export function layerFromFlags(flags: DatabaseFlags = readRuntimeFlags()) {
  log.info("opening database", { path: getPath(flags) })
  return ScopedDatabase.layerFromPath(getPath(flags), flags.skipMigrations ? ScopedDatabase.noMigrations : undefined)
}

export const layer = layerFromFlags()

type CompatRuntime = ManagedRuntime.ManagedRuntime<ScopedDatabase.Service, never>
let effectCompat: { key: string; runtime: CompatRuntime } | undefined

interface LegacyCompat {
  readonly key: string
  readonly native: BunSqliteDatabase
  readonly client: Client
}

let legacyCompat: LegacyCompat | undefined

function currentService() {
  const fiber = Fiber.getCurrent()
  if (!fiber) return undefined
  const service = Context.getOption(fiber.context, ScopedDatabase.Service)
  return service._tag === "Some" ? service.value : undefined
}

function compatibilityRuntime(flags: DatabaseFlags = readRuntimeFlags()) {
  const key = `${getPath(flags)}\0${flags.skipMigrations ? "skip" : "migrate"}`
  if (effectCompat && effectCompat.key !== key) {
    void effectCompat.runtime.dispose()
    effectCompat = undefined
  }
  if (!effectCompat) effectCompat = { key, runtime: ManagedRuntime.make(layerFromFlags(flags)) }
  return effectCompat
}

function compatibilityServiceEffect(flags: DatabaseFlags = readRuntimeFlags()) {
  const active = currentService()
  if (active) return Effect.succeed(active)
  return Effect.promise(() => compatibilityRuntime(flags).runtime.runPromise(ScopedDatabase.Service))
}

function compatibilityLegacy(flags: DatabaseFlags = readRuntimeFlags()): Client {
  const active = currentService()
  if (active) return active.legacy

  const key = `${getPath(flags)}\0${flags.skipMigrations ? "skip" : "migrate"}`
  if (legacyCompat && legacyCompat.key !== key) {
    legacyCompat.native.close()
    legacyCompat = undefined
  }
  if (!legacyCompat) {
    const native = new BunSqliteDatabase(getPath(flags))
    native.run("PRAGMA journal_mode = WAL")
    native.run("PRAGMA synchronous = NORMAL")
    native.run("PRAGMA busy_timeout = 5000")
    native.run("PRAGMA cache_size = -64000")
    native.run("PRAGMA foreign_keys = ON")
    native.run("PRAGMA wal_checkpoint(PASSIVE)")
    legacyCompat = { key, native, client: drizzle({ client: native }) }
  }
  return legacyCompat.client
}

export function Client(flags: DatabaseFlags = readRuntimeFlags()): Client {
  return compatibilityLegacy(flags)
}

export function close() {
  if (legacyCompat) {
    legacyCompat.native.close()
    legacyCompat = undefined
  }
  if (effectCompat) {
    const current = effectCompat
    effectCompat = undefined
    void current.runtime.dispose()
  }
}

interface TransactionState {
  readonly tx: TxOrDb
  readonly effects: Array<() => unknown | Promise<unknown>>
}

const TransactionRef = Context.Reference<TransactionState | undefined>("@jyycode/storage/DatabaseTransaction", {
  defaultValue: () => undefined,
})

function transactionState() {
  const fiber = Fiber.getCurrent()
  return fiber ? Context.get(fiber.context, TransactionRef) : undefined
}

function withTransactionState<T>(state: TransactionState, callback: () => T) {
  const fiber = Fiber.getCurrent()
  const context = Context.add(fiber?.context ?? Context.empty(), TransactionRef, state)
  return Effect.runSync(Effect.sync(callback).pipe(Effect.provide(context)))
}

export function use<T>(callback: (trx: TxOrDb) => T): T {
  const active = transactionState()
  if (active) return callback(active.tx)

  const effects: Array<() => unknown | Promise<unknown>> = []
  const result = withTransactionState({ effects, tx: compatibilityLegacy() }, () =>
    callback(compatibilityLegacy()),
  )
  for (const pending of effects) void pending()
  return result
}

/**
 * Explicit compatibility boundary for synchronous public APIs and CLI/admin
 * code that cannot yet yield Effect-backed Drizzle queries.
 */
export const legacyQuery = use

export function effect(fn: () => unknown | Promise<unknown>) {
  const bound = EffectBridge.bind(fn)
  const active = transactionState()
  if (active) active.effects.push(bound)
  else void bound()
}

type NotPromise<T> = T extends Promise<any> ? never : T

export function transaction<T>(
  callback: (tx: TxOrDb) => NotPromise<T>,
  options?: { behavior?: "deferred" | "immediate" | "exclusive" },
): NotPromise<T> {
  const active = transactionState()
  if (active) return callback(active.tx)

  const database = compatibilityLegacy()
  const effects: Array<() => unknown | Promise<unknown>> = []
  const result = database.transaction(
    ((tx: Transaction) => withTransactionState({ tx, effects }, () => callback(tx))) as any,
    { behavior: options?.behavior },
  )
  for (const pending of effects) void pending()
  return result as NotPromise<T>
}

export const legacyTransaction = transaction
export const legacyClient = Client

export * as Database from "./db"
