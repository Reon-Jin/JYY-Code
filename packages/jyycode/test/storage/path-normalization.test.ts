import { describe, expect, test } from "bun:test"
import { Database as BunDatabase } from "bun:sqlite"
import { drizzle } from "drizzle-orm/bun-sqlite"
import { integer, sqliteTable } from "drizzle-orm/sqlite-core"
import { absoluteArrayColumn, directoryColumn, pathColumn } from "@jyycode-ai/core/database/path"
import type { AbsolutePath } from "@jyycode-ai/core/schema"
import { Database as ScopedDatabase } from "@jyycode-ai/core/database/database"
import { DatabaseMigration } from "@jyycode-ai/core/database/migration"
import normalizeStoragePaths from "@jyycode-ai/core/database/migration/20260702000000_normalize_storage_paths"
import { Effect, Exit } from "effect"
import { sql } from "drizzle-orm"
import { tmpdir } from "../fixture/fixture"

const paths = sqliteTable("paths", {
  id: integer().primaryKey(),
  directory: directoryColumn().notNull(),
  path: pathColumn(),
  sandboxes: absoluteArrayColumn().notNull(),
})

function database() {
  const native = new BunDatabase(":memory:")
  native.run("CREATE TABLE paths (id INTEGER PRIMARY KEY, directory TEXT NOT NULL, path TEXT, sandboxes TEXT NOT NULL)")
  return { native, db: drizzle({ client: native }) }
}

describe("storage path columns", () => {
  test("normalizes Windows directories and relative paths for storage", () => {
    const { native, db } = database()
    try {
      const directory = process.platform === "win32" ? "C:\\repo\\subdir" : "/repo/subdir"
      const relative = process.platform === "win32" ? "packages\\jyycode" : "packages/jyycode"
      db.insert(paths)
        .values({ id: 1, directory, path: relative, sandboxes: [directory as AbsolutePath] })
        .run()

      const stored = native.query("SELECT directory, path, sandboxes FROM paths WHERE id = 1").get() as {
        directory: string
        path: string
        sandboxes: string
      }
      expect(stored.directory).toBe(process.platform === "win32" ? "C:/repo/subdir" : "/repo/subdir")
      expect(stored.path).toBe("packages/jyycode")
      expect(JSON.parse(stored.sandboxes)).toEqual([process.platform === "win32" ? "C:/repo/subdir" : "/repo/subdir"])

      const selected = db.select().from(paths).get()!
      expect(selected.directory).toBe(directory)
      expect(selected.sandboxes).toEqual([directory as AbsolutePath])
    } finally {
      native.close()
    }
  })

  test("round-trips UNC paths on Windows", () => {
    if (process.platform !== "win32") return
    const { native, db } = database()
    try {
      db.insert(paths).values({ id: 1, directory: "\\\\server\\share", path: "", sandboxes: [] }).run()
      expect((native.query("SELECT directory FROM paths").get() as { directory: string }).directory).toBe(
        "//server/share",
      )
      expect(db.select().from(paths).get()?.directory).toBe("\\\\server\\share")
    } finally {
      native.close()
    }
  })

  test("rejects relative directories and reads the legacy empty directory", () => {
    const { native, db } = database()
    try {
      expect(() => db.insert(paths).values({ id: 1, directory: "relative", path: "", sandboxes: [] }).run()).toThrow(
        "Path is not absolute",
      )
      native.run("INSERT INTO paths (id, directory, path, sandboxes) VALUES (2, '', '', '[]')")
      expect(db.select().from(paths).get()?.directory).toBe("")
    } finally {
      native.close()
    }
  })
})

describe("storage path migration", () => {
  test("backfills legacy separators idempotently", async () => {
    await using dir = await tmpdir()
    const filename = `${dir.path}/paths.db`
    const result = await Effect.runPromise(
      ScopedDatabase.Service.use(({ db }) =>
        Effect.gen(function* () {
          yield* db.run("CREATE TABLE project (id TEXT PRIMARY KEY, worktree TEXT NOT NULL, sandboxes TEXT NOT NULL)")
          yield* db.run("CREATE TABLE session (id TEXT PRIMARY KEY, directory TEXT NOT NULL, path TEXT)")
          yield* db.run(
            sql`INSERT INTO project VALUES ('project', ${"C:\\Repo"}, ${JSON.stringify(["C:\\Repo\\box"])})`,
          )
          yield* db.run(sql`INSERT INTO session VALUES ('session', ${"C:\\Repo"}, ${"packages\\jyycode"})`)
          yield* DatabaseMigration.applyOnly(db, [normalizeStoragePaths])
          yield* DatabaseMigration.applyOnly(db, [normalizeStoragePaths])
          return {
            project: yield* db.get<{ worktree: string; sandboxes: string }>(
              sql`SELECT worktree, sandboxes FROM project`,
            ),
            session: yield* db.get<{ directory: string; path: string }>(sql`SELECT directory, path FROM session`),
            applied: yield* db.all<{ id: string }>(sql`SELECT id FROM migration`),
          }
        }),
      ).pipe(Effect.provide(ScopedDatabase.layerFromPath(filename, ScopedDatabase.noMigrations)), Effect.scoped),
    )
    expect(result.project).toEqual({ worktree: "C:/Repo", sandboxes: JSON.stringify(["C:/Repo/box"]) })
    expect(result.session).toEqual({ directory: "C:/Repo", path: "packages/jyycode" })
    expect(result.applied).toEqual([{ id: normalizeStoragePaths.id }])
  })

  test("fails before updating colliding project paths", async () => {
    await using dir = await tmpdir()
    const filename = `${dir.path}/collisions.db`
    const result = await Effect.runPromise(
      ScopedDatabase.Service.use(({ db }) =>
        Effect.gen(function* () {
          yield* db.run("CREATE TABLE project (id TEXT PRIMARY KEY, worktree TEXT NOT NULL, sandboxes TEXT NOT NULL)")
          yield* db.run("CREATE TABLE session (id TEXT PRIMARY KEY, directory TEXT NOT NULL, path TEXT)")
          yield* db.run(sql`INSERT INTO project VALUES ('one', ${"C:\\Repo"}, '[]')`)
          yield* db.run(sql`INSERT INTO project VALUES ('two', ${"c:/repo"}, '[]')`)
          const exit = yield* DatabaseMigration.applyOnly(db, [normalizeStoragePaths]).pipe(Effect.exit)
          return {
            failed: Exit.isFailure(exit),
            worktrees: yield* db.all<{ worktree: string }>(sql`SELECT worktree FROM project ORDER BY id`),
          }
        }),
      ).pipe(Effect.provide(ScopedDatabase.layerFromPath(filename, ScopedDatabase.noMigrations)), Effect.scoped),
    )
    expect(result.failed).toBe(true)
    expect(result.worktrees).toEqual([{ worktree: "C:\\Repo" }, { worktree: "c:/repo" }])
  })
})
