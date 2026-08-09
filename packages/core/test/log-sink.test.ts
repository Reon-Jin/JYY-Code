import { describe, expect, test } from "bun:test"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { BoundedLogSink, formatLogValue, redactLogText } from "../src/util/log-sink"

describe("bounded log sink", () => {
  test("redacts credentials and bounds object serialization", () => {
    expect(redactLogText("Authorization: Bearer secret x-api-key=abc Cookie: sid=1 /home/alice/db")).not.toContain("secret")
    expect(formatLogValue({ payload: "x".repeat(100_000), nested: { ok: true } }, 512).length).toBeLessThanOrEqual(512)
  })

  test("rotates and keeps file/queue limits bounded", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "jyycode-log-"))
    const sink = new BoundedLogSink({ file: path.join(dir, "run.log"), maxFileBytes: 128, maxTotalBytes: 384, maxFiles: 3, maxRecordBytes: 64, queueCapacity: 4 })
    for (let index = 0; index < 100; index++) sink.write(`${index}:${"x".repeat(200)}`)
    await sink.flush(2_000)
    const names = await fs.readdir(dir)
    const stats = await Promise.all(names.map(async (name) => fs.stat(path.join(dir, name))))
    expect(names.length).toBeLessThanOrEqual(3)
    expect(Math.max(...stats.map((stat) => stat.size))).toBeLessThanOrEqual(128 + 64)
    expect(sink.stats().dropped).toBeGreaterThanOrEqual(0)
    await fs.rm(dir, { recursive: true, force: true })
  })
})
