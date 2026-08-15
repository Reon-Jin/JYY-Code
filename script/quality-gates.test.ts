import { describe, expect, test } from "bun:test"
import { readFile } from "node:fs/promises"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

const rootDir = join(dirname(fileURLToPath(import.meta.url)), "..")

async function json(path: string) {
  return JSON.parse(await readFile(join(rootDir, path), "utf8")) as Record<string, any>
}

describe("repository quality gates", () => {
  test("declares root and app CI test entry points", async () => {
    const root = await json("package.json")
    const app = await json("packages/app/package.json")
    const turbo = await json("turbo.json")

    expect(root.scripts).toMatchObject({
      "test:ci": "bun turbo test:ci",
    })
    expect(root.scripts["check:ci"]).toContain("bun run lint")
    expect(root.scripts["check:ci"]).toContain("bun run typecheck")
    expect(root.scripts["check:ci"]).toContain("bun run verify:architecture")
    expect(root.scripts["check:ci"]).toContain("bun run verify:generated")
    expect(root.scripts["check:ci"]).toContain("bun run test:ci")
    expect(app.scripts["test:ci"]).toBeString()
    expect(turbo.tasks["test:ci"].outputs).toContain(".artifacts/unit/junit.xml")
  })

  test("runs product, desktop, and process gates in CI", async () => {
    const workflow = await readFile(join(rootDir, ".github/workflows/test.yml"), "utf8")

    expect(workflow).toContain("product-tests:")
    expect(workflow).toContain("desktop:")
    expect(workflow).toContain("core-process:")
    expect(workflow).toContain("bun run --cwd packages/jyycode test:ci")
    expect(workflow).toContain("bun run --cwd packages/jyycode test:httpapi")
    expect(workflow).toContain("bun run verify:architecture")
    expect(workflow).toContain("bun run verify:generated")
    expect(workflow).toContain(".artifacts/**/junit.xml")
  })
})
