import { describe, expect } from "bun:test"
import path from "path"
import { Effect } from "effect"
import { Global } from "@jyycode-ai/core/global"
import { InstallationChannel } from "@jyycode-ai/core/installation/version"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { Database } from "@/storage/db"
import { it } from "../lib/effect"
import { Flag } from "@jyycode-ai/core/flag/flag"

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
