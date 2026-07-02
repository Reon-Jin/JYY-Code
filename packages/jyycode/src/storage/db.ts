import { migrate } from "drizzle-orm/bun-sqlite/migrator"
export * from "drizzle-orm"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { Global } from "@jyycode-ai/core/global"
import * as Log from "@jyycode-ai/core/util/log"
import { NamedError } from "@jyycode-ai/core/util/error"
import path from "path"
import { readFileSync, readdirSync, existsSync } from "fs"
import { Flag } from "@jyycode-ai/core/flag/flag"
import { InstallationChannel } from "@jyycode-ai/core/installation/version"
import { EffectBridge } from "@/effect/bridge"
import { Context, Effect, Fiber, ManagedRuntime } from "effect"
import { Database as ScopedDatabase } from "@jyycode-ai/core/database/database"
import { Schema } from "effect"

declare const JYYCODE_MIGRATIONS: { sql: string; timestamp: number; name: string }[] | undefined

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
    source: Flag.JYYCODE_DB ? ("override" as const) : flags.disableChannelDb ? ("shared" as const) : ("channel" as const),
    shared: flags.disableChannelDb || ["latest", "beta", "prod"].includes(InstallationChannel),
  }
}

export type Client = ScopedDatabase.Interface["legacy"]
export type Transaction = Parameters<Parameters<Client["transaction"]>[0]>[0]
export type TxOrDb = Transaction | Client

type Journal = { sql: string; timestamp: number; name: string }[]

const migrateFromJournal = migrate as unknown as (db: Client, entries: Journal) => void

function applyMigrations(db: Client, entries: Journal) {
  migrateFromJournal(db, entries)
}

function time(tag: string) {
  const match = /^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})/.exec(tag)
  if (!match) return 0
  return Date.UTC(
    Number(match[1]),
    Number(match[2]) - 1,
    Number(match[3]),
    Number(match[4]),
    Number(match[5]),
    Number(match[6]),
  )
}

function migrations(dir: string): Journal {
  const dirs = readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)

  const sql = dirs
    .map((name) => {
      const file = path.join(dir, name, "migration.sql")
      if (!existsSync(file)) return
      return {
        sql: readFileSync(file, "utf-8"),
        timestamp: time(name),
        name,
      }
    })
    .filter(Boolean) as Journal

  return sql.sort((a, b) => a.timestamp - b.timestamp)
}

function initialize(flags: DatabaseFlags): ScopedDatabase.Initialize {
  return ({ legacy }) =>
    Effect.sync(() => {
      const entries =
        typeof JYYCODE_MIGRATIONS !== "undefined"
          ? JYYCODE_MIGRATIONS
          : migrations(path.join(import.meta.dirname, "../../migration"))
      if (entries.length === 0) return
      log.info("applying migrations", {
        count: entries.length,
        mode: typeof JYYCODE_MIGRATIONS !== "undefined" ? "bundled" : "dev",
      })
      applyMigrations(
        legacy,
        flags.skipMigrations ? entries.map((item) => ({ ...item, sql: "select 1;" })) : entries,
      )
    })
}

export function layerFromFlags(flags: DatabaseFlags = readRuntimeFlags()) {
  return ScopedDatabase.layerFromPath(getPath(flags), initialize(flags))
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

export * as Database from "./db"
