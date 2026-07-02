import { describe, expect, test } from "bun:test"
import path from "path"
import { Database as BunDatabase } from "bun:sqlite"
import { Flag } from "@jyycode-ai/core/flag/flag"
import { collectDatabaseStatus } from "@/cli/cmd/db"
import { tmpdir } from "../fixture/fixture"

function fixture(file: string, sessions: number, full = false) {
  const db = new BunDatabase(file)
  try {
    db.run("CREATE TABLE session (id TEXT PRIMARY KEY)")
    for (let i = 0; i < sessions; i++) db.run("INSERT INTO session (id) VALUES (?)", [`session-${i}`])
    if (full) {
      db.run("CREATE TABLE project (id TEXT PRIMARY KEY)")
      db.run("CREATE TABLE message (id TEXT PRIMARY KEY)")
      db.run("CREATE TABLE part (id TEXT PRIMARY KEY)")
      db.run("CREATE TABLE __drizzle_migrations (id INTEGER PRIMARY KEY, hash TEXT, created_at NUMERIC)")
      db.run("INSERT INTO project (id) VALUES ('project-1')")
      db.run("INSERT INTO message (id) VALUES ('message-1')")
      db.run("INSERT INTO part (id) VALUES ('part-1')")
      db.run("INSERT INTO __drizzle_migrations (hash, created_at) VALUES ('migration-1', 1)")
    }
  } finally {
    db.close()
  }
}

describe("database status", () => {
  test.serial("reports the active and inactive channel databases without modifying them", async () => {
    await using dir = await tmpdir()
    const active = path.join(dir.path, "jyycode-local.db")
    const inactive = path.join(dir.path, "jyycode.db")
    fixture(active, 0, true)
    fixture(inactive, 4)

    const previous = Flag.JYYCODE_DB
    Flag.JYYCODE_DB = active
    try {
      const status = collectDatabaseStatus({ disableChannelDb: false })
      expect(status.active.path).toBe(active)
      expect(status.active.counts).toEqual({ sessions: 0, projects: 1, messages: 1, parts: 1, migrations: 1 })
      expect(status.databases).toContainEqual(
        expect.objectContaining({ path: inactive, sessions: 4 }),
      )
      expect(status.hint).toContain("JYYCODE_DISABLE_CHANNEL_DB=1")

      const verify = new BunDatabase(inactive, { readonly: true })
      try {
        expect(verify.query("SELECT count(*) AS count FROM session").get()).toEqual({ count: 4 })
      } finally {
        verify.close()
      }
    } finally {
      Flag.JYYCODE_DB = previous
    }
  })
})
