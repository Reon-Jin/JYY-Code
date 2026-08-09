export * as DatabaseMigration from "./migration"

import { sql } from "drizzle-orm"
import { Effect, Semaphore } from "effect"
import type { EffectDrizzleSqlite } from "@jyycode-ai/effect-drizzle-sqlite"
import { migrations } from "./migration.gen"
import schema from "./schema.gen"

type Database = EffectDrizzleSqlite.EffectSQLiteDatabase
type Transaction = Parameters<Parameters<Database["transaction"]>[0]>[0]
const lock = Semaphore.makeUnsafe(1)
const normalizeLegacyMigrationId = (id: string) => id.replaceAll("_", "").replaceAll("-", "")

export type Migration = {
  readonly id: string
  readonly up: (tx: Transaction) => Effect.Effect<void, unknown>
}

export function apply(db: Database) {
  return lock.withPermit(
    Effect.gen(function* () {
      const tables = yield* db.all<{ name: string }>(
        sql`SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'`,
      )
      if (tables.some((table) => table.name === "session")) return yield* applyOnly(db, migrations)
      if (tables.length > 0) return yield* Effect.die("Database is not empty and has no session table")
      yield* db.transaction((tx) =>
        Effect.gen(function* () {
          yield* schema.up(tx)
          yield* tx.run(
            sql`CREATE TABLE ${sql.identifier("migration")} (id TEXT PRIMARY KEY, time_completed INTEGER NOT NULL)`,
          )
          const completed = Date.now()
          yield* Effect.forEach(
            migrations,
            (migration) =>
              tx.run(
                sql`INSERT INTO ${sql.identifier("migration")} (id, time_completed) VALUES (${migration.id}, ${completed})`,
              ),
            { discard: true },
          )
        }),
      )
    }),
  )
}

export function applyOnly(db: Database, input: readonly Migration[]) {
  return Effect.gen(function* () {
    yield* db.run(
      sql`CREATE TABLE IF NOT EXISTS ${sql.identifier("migration")} (id TEXT PRIMARY KEY, time_completed INTEGER NOT NULL)`,
    )
    let completed = new Set(
      (yield* db.all<{ id: string }>(sql`SELECT id FROM ${sql.identifier("migration")}`)).map((row) => row.id),
    )
    if (completed.size === 0) {
      const legacy = yield* db.get<{ name: string }>(
        sql`SELECT name FROM sqlite_master WHERE type = 'table' AND name = ${"__drizzle_migrations"}`,
      )
      if (legacy) {
        yield* db.run(sql`
          INSERT OR IGNORE INTO ${sql.identifier("migration")} (id, time_completed)
          SELECT name, ${Date.now()}
          FROM ${sql.identifier("__drizzle_migrations")}
          WHERE name IS NOT NULL
        `)
        completed = new Set(
          (yield* db.all<{ id: string }>(sql`SELECT id FROM ${sql.identifier("migration")}`)).map((row) => row.id),
        )
      }
    }

    for (const migration of input) {
      // Drizzle's generated folder names may retain hyphens while the TypeScript
      // module identifier uses underscores. Treat the filesystem spelling as a
      // legacy alias so upgrading an existing database does not rerun a DDL step.
      const normalizedID = normalizeLegacyMigrationId(migration.id)
      if ([...completed].some((id) => normalizeLegacyMigrationId(id) === normalizedID)) continue
      yield* db.transaction((tx) =>
        Effect.gen(function* () {
          yield* migration.up(tx)
          yield* tx.run(
            sql`INSERT INTO ${sql.identifier("migration")} (id, time_completed) VALUES (${migration.id}, ${Date.now()})`,
          )
        }),
      )
    }
  })
}
