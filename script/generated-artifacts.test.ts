import { describe, expect, test } from "bun:test"
import path from "node:path"
import { buildEventCatalog, verifyEventCatalog } from "./verify-event-catalog"
import { verifyGeneratedSdkBuild, verifyGeneratedSdkLayout } from "./verify-generated-sdk"

const rootDir = path.resolve(import.meta.dir, "..")

describe("generated runtime artifacts", () => {
  test("catalogs every durable EventV2 definition with a projector and schema hash", async () => {
    const entries = await buildEventCatalog(rootDir)
    expect(entries.length).toBeGreaterThan(0)
    expect(new Set(entries.map((entry) => entry.type)).size).toBe(entries.length)
    for (const entry of entries) {
      expect(entry.version).toBeGreaterThanOrEqual(1)
      expect(entry.aggregate).toBeTruthy()
      expect(entry.schema_hash).toMatch(/^[a-f0-9]{64}$/)
      expect(entry.projector).toBeTruthy()
    }
  })

  test("tracked event catalog and generated SDK are clean", async () => {
    expect(await verifyEventCatalog({ rootDir, check: true })).toMatchObject({ ok: true })
    expect(await verifyGeneratedSdkLayout(rootDir)).toMatchObject({ ok: true })
    expect(await verifyGeneratedSdkBuild(rootDir)).toMatchObject({ ok: true })
  }, 120_000)
})
