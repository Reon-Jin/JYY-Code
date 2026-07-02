export * as Database from "./database"

import { EffectDrizzleSqlite } from "@jyycode-ai/effect-drizzle-sqlite"
import { layer as sqliteLayer } from "#sqlite"
import { Context, Effect, Layer } from "effect"
import { Sqlite } from "./sqlite"
import { DatabaseMigration } from "./migration"

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
