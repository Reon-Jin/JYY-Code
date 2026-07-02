import { describe, expect, test } from "bun:test"
import { Database as BunDatabase } from "bun:sqlite"
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Effect, Exit } from "effect"
import { sql } from "drizzle-orm"
import { Database } from "../src/database/database"
import { DatabaseMigration } from "../src/database/migration"
import { migrations } from "../src/database/migration.gen"

async function cleanup(directory: string, attempts = 20): Promise<void> {
  Bun.gc(true)
  await Bun.sleep(50)
  return rm(directory, { recursive: true, force: true }).catch((error) => {
    if (attempts <= 1 || error?.code !== "EBUSY") throw error
    return cleanup(directory, attempts - 1)
  })
}

const withDatabase = <A, E>(
  filename: string,
  effect: Effect.Effect<A, E, Database.Service>,
  initialize?: Database.Initialize,
) => Effect.runPromise(effect.pipe(Effect.provide(Database.layerFromPath(filename, initialize)), Effect.scoped))

describe("database migrations", () => {
  test("bootstraps an empty database and records the typed journal", async () => {
    const dir = await mkdtemp(join(tmpdir(), "jyycode-migration-"))
    const filename = join(dir, "empty.db")
    try {
      const result = await withDatabase(
        filename,
        Database.Service.use(({ db }) =>
          Effect.all({
            session: db.get<{ name: string }>(sql`SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'session'`),
            applied: db.all<{ id: string }>(sql`SELECT id FROM migration ORDER BY id`),
          }),
        ),
      )
      expect(result.session?.name).toBe("session")
      expect(result.applied.map((item) => item.id)).toEqual(migrations.map((item) => item.id))
    } finally {
      await cleanup(dir)
    }
  })

  test("seeds the typed journal from the legacy Drizzle journal", async () => {
    const dir = await mkdtemp(join(tmpdir(), "jyycode-migration-"))
    const filename = join(dir, "legacy.db")
    const native = new BunDatabase(filename)
    native.run("CREATE TABLE session (id TEXT PRIMARY KEY)")
    native.run("CREATE TABLE __drizzle_migrations (name TEXT)")
    for (const migration of migrations) native.run("INSERT INTO __drizzle_migrations (name) VALUES (?)", [migration.id])
    native.close()
    try {
      const applied = await withDatabase(
        filename,
        Database.Service.use(({ db }) => db.all<{ id: string }>(sql`SELECT id FROM migration ORDER BY id`)),
      )
      expect(applied.map((item) => item.id)).toEqual(migrations.map((item) => item.id))
    } finally {
      await cleanup(dir)
    }
  })

  test("runs migrations in order, rolls back failures, and retries exactly once", async () => {
    const dir = await mkdtemp(join(tmpdir(), "jyycode-migration-"))
    const filename = join(dir, "retry.db")
    const calls: string[] = []
    let fail = true
    const input: DatabaseMigration.Migration[] = [
      {
        id: "one",
        up: (tx) => tx.run(sql`CREATE TABLE one (id INTEGER)`).pipe(Effect.tap(() => Effect.sync(() => calls.push("one")))),
      },
      {
        id: "two",
        up: (tx) =>
          Effect.gen(function* () {
            calls.push("two")
            yield* tx.run(sql`CREATE TABLE two (id INTEGER)`)
            if (fail) return yield* Effect.fail(new Error("migration failed"))
          }),
      },
    ]
    try {
      await withDatabase(
        filename,
        Database.Service.use(({ db }) =>
          Effect.gen(function* () {
            const first = yield* DatabaseMigration.applyOnly(db, input).pipe(Effect.exit)
            expect(Exit.isFailure(first)).toBe(true)
            expect(yield* db.get(sql`SELECT name FROM sqlite_master WHERE name = 'two'`)).toBeUndefined()
            fail = false
            yield* DatabaseMigration.applyOnly(db, input)
            yield* DatabaseMigration.applyOnly(db, input)
            expect(yield* db.all<{ id: string }>(sql`SELECT id FROM migration ORDER BY id`)).toEqual([
              { id: "one" },
              { id: "two" },
            ])
          }),
        ),
        Database.noMigrations,
      )
      expect(calls).toEqual(["one", "two", "two"])
    } finally {
      await cleanup(dir)
    }
  })

  test("preserves row counts when upgrading a legacy real-schema fixture", async () => {
    const dir = await mkdtemp(join(tmpdir(), "jyycode-migration-"))
    const filename = join(dir, "legacy-schema.db")
    const native = new BunDatabase(filename)
    const migrationRoot = join(import.meta.dir, "../../jyycode/migration")
    const names = (await readdir(migrationRoot, { withFileTypes: true }))
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort()
    for (const name of names) {
      const source = await readFile(join(migrationRoot, name, "migration.sql"), "utf8")
      native.exec(source.replaceAll("--> statement-breakpoint", ""))
    }
    native.run("CREATE TABLE __drizzle_migrations (name TEXT)")
    for (const name of names) native.run("INSERT INTO __drizzle_migrations (name) VALUES (?)", [name])
    native.run(
      "INSERT INTO project (id, worktree, time_created, time_updated, sandboxes) VALUES ('project', 'C:/repo', 1, 1, '[]')",
    )
    native.run(
      "INSERT INTO session (id, project_id, slug, directory, title, version, cost, tokens_input, tokens_output, tokens_reasoning, tokens_cache_read, tokens_cache_write, time_created, time_updated) VALUES ('session', 'project', 'slug', 'C:/repo', 'title', 'test', 0, 0, 0, 0, 0, 0, 1, 1)",
    )
    native.run("INSERT INTO message (id, session_id, time_created, time_updated, data) VALUES ('message', 'session', 1, 1, '{}')")
    native.run(
      "INSERT INTO part (id, message_id, session_id, time_created, time_updated, data) VALUES ('part', 'message', 'session', 1, 1, '{}')",
    )
    const before = ["project", "session", "message", "part"].map(
      (table) => (native.query(`SELECT count(*) AS count FROM ${table}`).get() as { count: number }).count,
    )
    native.close()

    try {
      const after = await withDatabase(
        filename,
        Database.Service.use(({ db }) =>
          Effect.forEach(["project", "session", "message", "part"], (table) =>
            db.get<{ count: number }>(sql.raw(`SELECT count(*) AS count FROM ${table}`)).pipe(
              Effect.map((row) => row?.count ?? 0),
            ),
          ),
        ),
      )
      expect(after).toEqual(before)
    } finally {
      await cleanup(dir)
    }
  })
})
