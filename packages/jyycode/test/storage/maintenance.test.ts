import { describe, expect, test } from "bun:test"
import { Database } from "bun:sqlite"
import { mkdtemp, rm, stat } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { maintainDatabase } from "@/storage/maintenance"

describe("storage maintenance", () => {
  test("dry-run does not checkpoint, vacuum, or change the database", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "jyycode-maintenance-"))
    const file = path.join(root, "session.db")
    const native = new Database(file)
    native.exec("PRAGMA auto_vacuum = INCREMENTAL; CREATE TABLE sample (value TEXT);")
    native.query("INSERT INTO sample VALUES (?)").run("x".repeat(4096))
    native.close()
    const before = await stat(file)
    const result = await maintainDatabase(file, { dryRun: true, maxVacuumPages: 2 })
    const after = await stat(file)
    expect(result.status).toBe("dry-run")
    expect(result.result?.checkpoint).toBe("planned")
    expect(result.result?.integrity).toBe("not-run")
    expect(after.size).toBe(before.size)
    expect(after.mtimeMs).toBe(before.mtimeMs)
    await rm(root, { recursive: true, force: true })
  })

  test("bounded maintenance runs integrity checks and keeps the database readable", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "jyycode-maintenance-"))
    const file = path.join(root, "session.db")
    const native = new Database(file)
    native.exec("PRAGMA auto_vacuum = INCREMENTAL; CREATE TABLE sample (value TEXT);")
    native.query("INSERT INTO sample VALUES (?)").run("x".repeat(4096))
    native.close()
    const result = await maintainDatabase(file, { dryRun: false, maxVacuumPages: 2 })
    expect(result.status).toBe("completed")
    expect(result.result?.checkpoint).toBe("completed")
    expect(result.result?.integrity).toBe("ok")
    const check = new Database(file, { readonly: true })
    expect(check.query("SELECT value FROM sample").get()).toEqual({ value: "x".repeat(4096) })
    check.close()
    await rm(root, { recursive: true, force: true })
  })

  test("full vacuum is explicit and dry-run remains non-mutating", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "jyycode-maintenance-"))
    const file = path.join(root, "session.db")
    const native = new Database(file)
    native.exec("CREATE TABLE sample (value TEXT);")
    native.close()
    const before = await stat(file)
    const result = await maintainDatabase(file, { dryRun: true, full: true })
    const after = await stat(file)
    expect(result.status).toBe("dry-run")
    expect(result.mode).toBe("full")
    expect(after.size).toBe(before.size)
    expect(after.mtimeMs).toBe(before.mtimeMs)
    await rm(root, { recursive: true, force: true })
  })
})
