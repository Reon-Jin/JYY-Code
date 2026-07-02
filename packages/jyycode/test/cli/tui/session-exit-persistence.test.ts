import { describe, expect, test } from "bun:test"

const source = await Bun.file(new URL("../../../src/cli/cmd/tui/app.tsx", import.meta.url)).text()

describe("TUI session exit policy", () => {
  test("does not delete the active session during shutdown", () => {
    expect(source).not.toMatch(/exit\.before\.add[\s\S]{0,600}session\.delete/)
  })
})
