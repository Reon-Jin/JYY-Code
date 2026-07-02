import { mkdir, mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { expect, test } from "bun:test"
import { SqliteClient } from "@effect/sql-sqlite-bun"
import { eq, sql } from "drizzle-orm"
import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core"
import { Effect } from "effect"
import type { SqlClient as SqlClientService } from "effect/unstable/sql/SqlClient"
import { EffectDrizzleSqlite } from "../src"

const users = sqliteTable("users", {
  id: integer().primaryKey({ autoIncrement: true }),
  name: text().notNull(),
})

const run = <A, E>(effect: Effect.Effect<A, E, SqlClientService>) =>
  Effect.runPromise(
    effect.pipe(Effect.provide(SqliteClient.layer({ filename: ":memory:", disableWAL: true })), Effect.scoped),
  )

const makeDb = Effect.gen(function* () {
  const db = yield* EffectDrizzleSqlite.makeWithDefaults()
  yield* db.run(sql`create table users (id integer primary key autoincrement, name text not null)`)
  return db
})

test("query builders are yieldable Effects", async () => {
  await run(
    Effect.gen(function* () {
      const db = yield* makeDb
      yield* db.insert(users).values({ name: "Ada" })
      expect(yield* db.select().from(users)).toEqual([{ id: 1, name: "Ada" }])
      expect(yield* db.select({ id: users.id }).from(users).where(eq(users.name, "Ada")).get()).toEqual({ id: 1 })
    }),
  )
})

test("commits immediate transactions", async () => {
  await run(
    Effect.gen(function* () {
      const db = yield* makeDb
      yield* db.transaction((tx) => tx.insert(users).values({ name: "Grace" }), { behavior: "immediate" })
      expect(yield* db.select().from(users)).toEqual([{ id: 1, name: "Grace" }])
    }),
  )
})

test("rolls back failed transactions", async () => {
  await run(
    Effect.gen(function* () {
      const db = yield* makeDb
      yield* db
        .transaction((tx) => tx.insert(users).values({ name: "Linus" }).pipe(Effect.andThen(Effect.fail("boom"))))
        .pipe(Effect.ignore)
      expect(yield* db.select().from(users)).toEqual([])
    }),
  )
})

test("runs migrations once and in order", async () => {
  const folder = await mkdtemp(join(tmpdir(), "effect-drizzle-sqlite-"))
  await mkdir(join(folder, "20240101000000_create_users"), { recursive: true })
  await mkdir(join(folder, "20240102000000_seed_users"), { recursive: true })
  await Bun.write(
    join(folder, "20240101000000_create_users", "migration.sql"),
    "create table migrated_users (id integer primary key, name text not null);",
  )
  await Bun.write(
    join(folder, "20240102000000_seed_users", "migration.sql"),
    "insert into migrated_users (id, name) values (1, 'Margaret');",
  )
  try {
    await run(
      Effect.gen(function* () {
        const db = yield* EffectDrizzleSqlite.makeWithDefaults()
        yield* EffectDrizzleSqlite.migrate(db, { migrationsFolder: folder })
        yield* EffectDrizzleSqlite.migrate(db, { migrationsFolder: folder })
        expect(yield* db.all<{ name: string }>(sql`select name from migrated_users`)).toEqual([{ name: "Margaret" }])
        expect(yield* db.all(sql`select name from __drizzle_migrations order by created_at`)).toHaveLength(2)
      }),
    )
  } finally {
    await rm(folder, { recursive: true, force: true })
  }
})

test("scope finalization closes the native connection", async () => {
  const folder = await mkdtemp(join(tmpdir(), "effect-drizzle-sqlite-close-"))
  const filename = join(folder, "close.db")
  await Effect.runPromise(
    Effect.gen(function* () {
      const db = yield* EffectDrizzleSqlite.makeWithDefaults()
      yield* db.run(sql`create table closed (id integer primary key)`)
    }).pipe(Effect.provide(SqliteClient.layer({ filename, disableWAL: true })), Effect.scoped),
  )
  await expect(rm(folder, { recursive: true, force: true })).resolves.toBeUndefined()
})
