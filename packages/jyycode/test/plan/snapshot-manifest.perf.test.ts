import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { afterEach, describe, expect, it } from "bun:test"
import { buildSnapshotManifest } from "../../src/plan/snapshot-manifest"

const cleanups: Array<() => void> = []
afterEach(() => {
  while (cleanups.length) cleanups.pop()!()
})

function fixtureRoot() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "jyycode-manifest-"))
  cleanups.push(() => fs.rmSync(root, { recursive: true, force: true }))
  return root
}

describe("snapshot manifest budget accounting", () => {
  it("threads total bytes through nested directories and enforces the limit", async () => {
    const root = fixtureRoot()
    fs.mkdirSync(path.join(root, "a", "b", "c"), { recursive: true })
    fs.writeFileSync(path.join(root, "a", "b", "c", "one.txt"), "x".repeat(600))
    fs.writeFileSync(path.join(root, "a", "two.txt"), "y".repeat(600))

    const manifest = await buildSnapshotManifest({ root })
    expect(manifest.file_count).toBe(2)
    expect(manifest.total_bytes).toBe(1200)

    await expect(buildSnapshotManifest({ root, limits: { maxTotalBytes: 1000 } })).rejects.toThrow(
      /total-byte limit/,
    )
  })

  it("accounts large trees linearly", async () => {
    const root = fixtureRoot()
    for (let index = 0; index < 600; index++) {
      fs.writeFileSync(path.join(root, `file-${index}.txt`), "x".repeat(1024))
    }
    const started = performance.now()
    const manifest = await buildSnapshotManifest({ root })
    const duration = performance.now() - started
    expect(manifest.file_count).toBe(600)
    expect(manifest.total_bytes).toBe(600 * 1024)
    expect(duration).toBeLessThan(5000)
  })
})
