import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { afterEach, describe, expect, it } from "bun:test"
import { buildSnapshotManifest, __snapshotHashStats } from "../../src/plan/snapshot-manifest"

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

  it("reuses the persisted hash cache on a second scan", async () => {
    const root = fixtureRoot()
    const runtime = fs.mkdtempSync(path.join(os.tmpdir(), "jyycode-manifest-runtime-"))
    cleanups.push(() => fs.rmSync(runtime, { recursive: true, force: true }))
    for (let index = 0; index < 40; index++) {
      fs.writeFileSync(path.join(root, `file-${index}.txt`), "x".repeat(128))
    }

    const first = await buildSnapshotManifest({ root, runtimeRoot: runtime })
    __snapshotHashStats.filesRead = 0
    const second = await buildSnapshotManifest({ root, runtimeRoot: runtime })

    expect(__snapshotHashStats.filesRead).toBe(0)
    expect(second.source_manifest_hash).toBe(first.source_manifest_hash)

    // A changed file invalidates only its own entry.
    fs.writeFileSync(path.join(root, "file-0.txt"), "y".repeat(128))
    __snapshotHashStats.filesRead = 0
    const third = await buildSnapshotManifest({ root, runtimeRoot: runtime })
    expect(__snapshotHashStats.filesRead).toBe(1)
    expect(third.source_manifest_hash).not.toBe(first.source_manifest_hash)
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
