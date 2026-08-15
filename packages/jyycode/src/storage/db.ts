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
    const db = active?.tx ?? compatibilityService().db
    return callback(db).pipe(Effect.orDie)
  })
}

export function withTransaction<A, E, R>(
  callback: (tx: EffectTxOrDb) => Effect.Effect<A, E, R>,
  options?: { behavior?: "deferred" | "immediate" | "exclusive" },
) {
  return Effect.withFiber((fiber) => {
    const active = Context.get(fiber.context, EffectTransactionRef)
    if (active) return callback(active.tx).pipe(Effect.orDie)
    const db = compatibilityService().db
    return db
      .transaction(
        (tx) =>
          Effect.gen(function* () {
            const state: EffectTransactionState = { tx, afterCommit: [] }
            const result = yield* callback(tx).pipe(Effect.provideService(EffectTransactionRef, state))
            return { result, effects: state.afterCommit }
          }),
        options,
      )
      .pipe(
        Effect.orDie,
        Effect.tap((committed) =>
          Effect.forEach(committed.effects, (pending) => pending.pipe(Effect.orDie), { discard: true }),
        ),
        Effect.map((committed) => committed.result),
      )
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
  log.debug("opening database", { path: getPath(flags) })
  return ScopedDatabase.layerFromPath(getPath(flags), flags.skipMigrations ? ScopedDatabase.noMigrations : undefined)
}

export const layer = layerFromFlags()

type CompatRuntime = ManagedRuntime.ManagedRuntime<ScopedDatabase.Service, never>
let compat: { key: string; runtime: CompatRuntime } | undefined

function currentService() {
  const fiber = Fiber.getCurrent()
  if (!fiber) return undefined
  const service = Context.getOption(fiber.context, ScopedDatabase.Service)
  return service._tag === "Some" ? service.value : undefined
}

function compatibilityService(flags: DatabaseFlags = readRuntimeFlags()) {
  const active = currentService()
  if (active) return active

  const key = `${getPath(flags)}\0${flags.skipMigrations ? "skip" : "migrate"}`
  if (compat && compat.key !== key) {
    Effect.runSync(compat.runtime.disposeEffect)
    compat = undefined
  }
  if (!compat) compat = { key, runtime: ManagedRuntime.make(layerFromFlags(flags)) }
  return compat.runtime.runSync(ScopedDatabase.Service)
}

export function Client(flags: DatabaseFlags = readRuntimeFlags()): Client {
  return compatibilityService(flags).legacy
}

export function close() {
  if (!compat) return
  const current = compat
  compat = undefined
  Effect.runSync(current.runtime.disposeEffect)
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
  const result = withTransactionState({ effects, tx: compatibilityService().legacy }, () =>
    callback(compatibilityService().legacy),
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

  const database = compatibilityService().legacy
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
