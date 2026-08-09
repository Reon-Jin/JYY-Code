import { describe, expect, test } from "bun:test"
import { Database } from "bun:sqlite"
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { auditStorage } from "@/cli/cmd/debug/storage-audit"

async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), "jyycode-storage-audit-"))
  await mkdir(path.join(root, "log"), { recursive: true })
  await Bun.write(path.join(root, "log", "today.jsonl"), "x".repeat(32))
  const db = new Database(path.join(root, "jyycode.db"))
  db.exec("CREATE TABLE session (id TEXT); CREATE TABLE message (id TEXT); CREATE TABLE part (id TEXT, data TEXT);")
  db.query("INSERT INTO session VALUES (?)").run("session-1")
  db.query("INSERT INTO message VALUES (?)").run("message-1")
  db.query("INSERT INTO part VALUES (?, ?)").run("part-1", JSON.stringify({ type: "tool", state: { output: "secret-body" } }))
  db.query("INSERT INTO part VALUES (?, ?)").run("part-2", JSON.stringify({ type: "file", url: "data:image/png;base64,AAAA" }))
  db.close()
  await writeFile(path.join(root, "jyycode-main.db"), "not-a-database")
  await writeFile(path.join(root, "jyycode.db.backup-20260705"), "backup")
  await writeFile(path.join(root, "jyycode.db.backup-unknown"), "backup")
  return root
}

describe("debug storage audit", () => {
  test("is read-only, classifies databases/backups, and omits message bodies", async () => {
    const root = await fixture()
    try {
      const target = path.join(root, "jyycode.db")
      const before = await stat(target)
      const report = await auditStorage({ root, queryDeadlineMs: 1000 })
      const after = await stat(target)
      const primary = report.databases.find((item) => item.path === target)
      expect(primary?.kind).toBe("active-channel-db")
      expect(primary?.readable).toBe(true)
      expect(primary?.sessionCount).toBe(1)
      expect(primary?.partCount).toBe(2)
      expect(primary?.base64PartBytes).toBeGreaterThan(0)
      expect(report.databases.some((item) => item.kind === "inactive-channel-db")).toBe(true)
      expect(report.backups.length).toBe(2)
      expect(report.databases.some((item) => item.kind === "recognized-migration-backup")).toBe(true)
      expect(report.databases.some((item) => item.kind === "unknown-backup")).toBe(true)
      expect(JSON.stringify(report)).not.toContain("secret-body")
      expect(after.mtimeMs).toBe(before.mtimeMs)
      expect(after.size).toBe(before.size)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test("an explicit database requires readonly mode", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "jyycode-storage-audit-"))
    const dbPath = path.join(root, "fixture.db")
    await writeFile(dbPath, "not-a-db")
    try {
      await expect(auditStorage({ database: dbPath })).rejects.toThrow("requires --readonly")
      expect((await readFile(dbPath)).toString()).toBe("not-a-db")
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})
