import { describe, expect, test } from "bun:test"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { blobPath } from "@/storage/blob-path"
import { inspectStorage, parseDuration, retentionDecision } from "@/storage/retention"

describe("storage retention policy", () => {
  test("preserves roots and unknown lifecycle states", () => {
    expect(retentionDecision({ root: true, lifecycle: "terminal" }).action).toBe("preserve")
    expect(retentionDecision({ lifecycle: "unknown" }).reason).toBe("unknown-lifecycle")
    expect(retentionDecision({ artifact: "backup" }).automatic).toBe(false)
  })

  test("preserves active, leased, and waiting sessions", () => {
    for (const lifecycle of ["active", "leased", "waiting_permission", "waiting_question"] as const) {
      const result = retentionDecision({ lifecycle, updatedAt: 0, now: 100_000_000, terminalChildTtlMs: 1 })
      expect(result.action).toBe("preserve")
    }
  })

  test("only expired terminal children are eligible for payload pruning", () => {
    expect(retentionDecision({ lifecycle: "terminal", updatedAt: 0, now: 31, terminalChildTtlMs: 30 })).toEqual({
      action: "prune_payload",
      reason: "terminal-child-expired",
      automatic: true,
    })
    expect(retentionDecision({ lifecycle: "terminal", updatedAt: 10, now: 20, terminalChildTtlMs: 30 }).action).toBe(
      "preserve",
    )
  })

  test("parses bounded cleanup durations", () => {
    expect(parseDuration("30d")).toBe(30 * 24 * 60 * 60 * 1000)
    expect(parseDuration("1.5h")).toBe(5_400_000)
    expect(() => parseDuration("forever")).toThrow()
  })

  test("inspects storage bytes without returning stored content", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "jyycode-retention-"))
    const digest = "a".repeat(64)
    try {
      await mkdir(path.dirname(blobPath(digest, root)), { recursive: true })
      await writeFile(blobPath(digest, root), Buffer.from("secret-blob"))
      await mkdir(path.join(root, "log"), { recursive: true })
      await writeFile(path.join(root, "log", "today.log"), "secret-log")
      const report = await inspectStorage(root)
      expect(report.blobs).toEqual({ count: 1, bytes: 11 })
      expect(report.logs).toEqual({ count: 1, bytes: 10 })
      expect(JSON.stringify(report)).not.toContain("secret-blob")
      expect(JSON.stringify(report)).not.toContain("secret-log")
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})
