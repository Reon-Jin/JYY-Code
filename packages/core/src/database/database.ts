export * as Database from "./database"

import { EffectDrizzleSqlite } from "@jyycode-ai/effect-drizzle-sqlite"
import { layer as sqliteLayer } from "#sqlite"
import { Context, Effect, Layer } from "effect"
import { Sqlite } from "./sqlite"
import { DatabaseMigration } from "./migration"
import type { Database as BunDatabase } from "bun:sqlite"

const makeDatabase = EffectDrizzleSqlite.makeWithDefaults()
export type EffectDatabase = Effect.Success<typeof makeDatabase>

export interface Interface {
  readonly db: EffectDatabase
  readonly legacy: Sqlite.DrizzleClient
  readonly native: Sqlite.NativeClient
}

export class Service extends Context.Service<Service, Interface>()("@jyycode/storage/Database") {}

export type Initialize = (database: Interface) => Effect.Effect<void>
export const noMigrations: Initialize = () => Effect.void

export type MaintenanceOptions = {
  readonly dryRun?: boolean
  readonly maxVacuumPages?: number
}

export type MaintenanceResult = {
  readonly dryRun: boolean
  readonly pageCount: number
  readonly freePagesBefore: number
  readonly vacuumPages: number
  readonly checkpoint: "planned" | "completed"
  readonly integrity: "not-run" | "ok"
}

function pragmaNumber(native: BunDatabase, name: string) {
  const row = native.query(`PRAGMA ${name}`).get() as Record<string, unknown> | null
  const value = row ? Object.values(row)[0] : 0
  const number = Number(value ?? 0)
  return Number.isFinite(number) && number >= 0 ? Math.floor(number) : 0
}

/**
 * Run the bounded, in-place portion of SQLite maintenance.
 *
 * This intentionally does not run VACUUM. Full rewrites need a temporary file,
 * an integrity check, and an atomic replacement policy, which are implemented
 * by the application storage-maintenance layer.
 */
export function maintainNative(native: BunDatabase, options: MaintenanceOptions = {}): MaintenanceResult {
  const dryRun = options.dryRun === true
  const pageCount = pragmaNumber(native, "page_count")
  const freePagesBefore = pragmaNumber(native, "freelist_count")
  const maxVacuumPages = Math.max(0, Math.floor(options.maxVacuumPages ?? 256))
  const vacuumPages = Math.min(freePagesBefore, maxVacuumPages)
  if (dryRun) {
    return {
      dryRun,
      pageCount,
      freePagesBefore,
      vacuumPages,
      checkpoint: "planned",
      integrity: "not-run",
    }
  }

  native.query("PRAGMA wal_checkpoint(PASSIVE)").get()
  if (vacuumPages > 0) native.run(`PRAGMA incremental_vacuum(${vacuumPages})`)
  const integrity = native.query("PRAGMA integrity_check(1)").get() as Record<string, unknown> | null
  const result = integrity ? Object.values(integrity)[0] : undefined
  if (result !== "ok") throw new Error(`SQLite integrity check failed: ${String(result ?? "unknown")}`)
  return {
    dryRun,
    pageCount,
    freePagesBefore,
    vacuumPages,
    checkpoint: "completed",
    integrity: "ok",
  }
}

const serviceLayer = (initialize?: Initialize) =>
  Layer.effect(
    Service,
    Effect.gen(function* () {
      const db = yield* makeDatabase
      const legacy = yield* Sqlite.Drizzle
      const native = yield* Sqlite.Native
      const service = Service.of({ db, legacy, native })

      yield* db.run("PRAGMA journal_mode = WAL")
      yield* db.run("PRAGMA synchronous = NORMAL")
      yield* db.run("PRAGMA busy_timeout = 5000")
      yield* db.run("PRAGMA cache_size = -64000")
      yield* db.run("PRAGMA foreign_keys = ON")
      yield* db.run("PRAGMA wal_checkpoint(PASSIVE)")
      if (initialize) yield* initialize(service)

      return service
    }).pipe(Effect.orDie),
  )

export function layerFromPath(
  filename: string,
  initialize: Initialize = ({ db }) => DatabaseMigration.apply(db).pipe(Effect.orDie),
) {
  return serviceLayer(initialize).pipe(Layer.provide(sqliteLayer({ filename })))
}
