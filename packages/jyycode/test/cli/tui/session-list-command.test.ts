import { describe, expect, test } from "bun:test"

const source = await Bun.file(new URL("../../../src/cli/cmd/tui/app.tsx", import.meta.url)).text()

describe("TUI session list command", () => {
  test("accepts the singular /session alias", () => {
    expect(source).toMatch(/name:\s*"session\.list"[\s\S]{0,300}slashAliases:\s*\[[^\]]*"session"/)
  })
})
