import { describe, expect, spyOn, test } from "bun:test"
import path from "path"
import { Effect } from "effect"
import { Database as BunDatabase } from "bun:sqlite"
import { Global } from "@jyycode-ai/core/global"
import { Database as ScopedDatabase } from "@jyycode-ai/core/database/database"
import { InstallationChannel } from "@jyycode-ai/core/installation/version"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { Database } from "@/storage/db"
import { it } from "../lib/effect"
import { Flag } from "@jyycode-ai/core/flag/flag"
import { tmpdir } from "../fixture/fixture"

describe("Database.getChannelPath", () => {
  it.effect("returns database path for the current channel", () =>
    Effect.gen(function* () {
      const flags = yield* RuntimeFlags.Service
      const expected = ["latest", "beta", "prod"].includes(InstallationChannel)
        ? path.join(Global.Path.data, "jyycode.db")
        : path.join(Global.Path.data, `jyycode-${InstallationChannel.replace(/[^a-zA-Z0-9._-]/g, "-")}.db`)

      expect(Database.getChannelPath(flags)).toBe(expected)
    }).pipe(Effect.provide(RuntimeFlags.layer())),
  )

  it.effect("uses the shared database path when channel databases are disabled", () =>
    Effect.gen(function* () {
      const flags = yield* RuntimeFlags.Service

      expect(Database.getChannelPath(flags)).toBe(path.join(Global.Path.data, "jyycode.db"))
    }).pipe(Effect.provide(RuntimeFlags.layer({ disableChannelDb: true }))),
  )

  it.effect("accepts RuntimeFlags with skipMigrations for database callers", () =>
    Effect.gen(function* () {
      const flags = yield* RuntimeFlags.Service

      expect(flags.skipMigrations).toBe(true)
      expect(Database.getChannelPath(flags)).toBe(Database.getChannelPath({ disableChannelDb: flags.disableChannelDb }))
    }).pipe(Effect.provide(RuntimeFlags.layer({ skipMigrations: true }))),
  )
})

describe("Database.describePath", () => {
  it.effect("describes the active channel selection", () =>
    Effect.gen(function* () {
      expect(Database.describePath({ disableChannelDb: false })).toEqual({
        path: Database.getPath({ disableChannelDb: false }),
        channel: InstallationChannel,
        source: Flag.JYYCODE_DB ? "override" : "channel",
        shared: ["latest", "beta", "prod"].includes(InstallationChannel),
      })
    }),
  )

  it.effect("describes an explicit shared database selection", () =>
    Effect.gen(function* () {
      const previous = Flag.JYYCODE_DB
      Flag.JYYCODE_DB = undefined
      try {
        expect(Database.describePath({ disableChannelDb: true })).toEqual({
          path: Database.getPath({ disableChannelDb: true }),
          channel: InstallationChannel,
          source: "shared",
          shared: true,
        })
      } finally {
        Flag.JYYCODE_DB = previous
      }
    }),
  )

  it.effect("resolves relative and absolute overrides", () =>
    Effect.gen(function* () {
      const previous = Flag.JYYCODE_DB
      try {
        Flag.JYYCODE_DB = "custom.db"
        expect(Database.describePath({ disableChannelDb: false }).path).toBe(path.join(Global.Path.data, "custom.db"))

        const absolute = path.resolve(Global.Path.data, "absolute.db")
        Flag.JYYCODE_DB = absolute
        expect(Database.describePath({ disableChannelDb: false }).path).toBe(absolute)
      } finally {
        Flag.JYYCODE_DB = previous
      }
    }),
  )
})

describe("scoped database service", () => {
  test.serial("shares one service and closes one native connection with its scope", async () => {
    await using dir = await tmpdir()
    const filename = path.join(dir.path, "scoped.db")
    let initialized = 0
    let closed = 0
    const original = BunDatabase.prototype.close
    const close = spyOn(BunDatabase.prototype, "close").mockImplementation(function (this: BunDatabase) {
      closed++
      return original.call(this)
    })
    const layer = ScopedDatabase.layerFromPath(filename, ({ legacy }) =>
      Effect.sync(() => {
        initialized++
        legacy.run("CREATE TABLE IF NOT EXISTS lifecycle (id INTEGER PRIMARY KEY)")
      }),
    )

    try {
      await Effect.runPromise(
        Effect.gen(function* () {
          const [first, second] = yield* Effect.all([ScopedDatabase.Service, ScopedDatabase.Service], {
            concurrency: "unbounded",
          })
          expect(first).toBe(second)
          first.legacy.run("INSERT INTO lifecycle (id) VALUES (1)")
        }).pipe(Effect.provide(layer), Effect.scoped),
      )
      expect(initialized).toBe(1)
      expect(closed).toBe(1)
    } finally {
      close.mockRestore()
    }
  })

  test("reopens a new scope on the same file without losing rows", async () => {
    await using dir = await tmpdir()
    const filename = path.join(dir.path, "reopen.db")
    const layer = () => ScopedDatabase.layerFromPath(filename)

    await Effect.runPromise(
      ScopedDatabase.Service.use((service) =>
        Effect.sync(() => {
          service.legacy.run("CREATE TABLE persisted (id INTEGER PRIMARY KEY)")
          service.legacy.run("INSERT INTO persisted (id) VALUES (1)")
        }),
      ).pipe(Effect.provide(layer()), Effect.scoped),
    )

    const count = await Effect.runPromise(
      ScopedDatabase.Service.use((service) =>
        Effect.sync(
          () => (service.legacy.get<{ count: number }>("SELECT count(*) AS count FROM persisted")?.count ?? 0),
        ),
      ).pipe(Effect.provide(layer()), Effect.scoped),
    )
    expect(count).toBe(1)
  })
})

describe("database compatibility context", () => {
  test.serial("reuses the transaction and runs effects only after commit", () => {
    Database.close()
    const order: string[] = []
    try {
      Database.transaction((tx) => {
        Database.use((nested) => expect(nested).toBe(tx))
        Database.effect(() => {
          order.push("after")
        })
        order.push("inside")
        expect(order).toEqual(["inside"])
      })
      expect(order).toEqual(["inside", "after"])
    } finally {
      Database.close()
    }
  })

  test.serial("does not run queued effects after rollback", () => {
    Database.close()
    const order: string[] = []
    try {
      expect(() =>
        Database.transaction(() => {
          Database.effect(() => {
            order.push("after")
          })
          throw new Error("rollback")
        }),
      ).toThrow("rollback")
      expect(order).toEqual([])
    } finally {
      Database.close()
    }
  })
})
