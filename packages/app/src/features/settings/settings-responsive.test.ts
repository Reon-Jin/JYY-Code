import { readFileSync } from "node:fs"
import { describe, expect, it } from "vitest"

const settings = readFileSync("src/features/settings/settings.css", "utf8")

describe("Settings responsive CSS contract", () => {
  it("keeps the page bounded while the settings content scrolls", () => {
    expect(settings).toMatch(/\.settings-page\s*\{[\s\S]*?height:\s*100%[\s\S]*?overflow:\s*hidden/)
    expect(settings).toMatch(/\.settings-content\s*\{[\s\S]*?min-height:\s*0[\s\S]*?overflow:\s*auto/)
  })

  it("moves section navigation above the content on narrow windows", () => {
    expect(settings).toMatch(/@media\s*\(max-width:\s*720px\)/)
    expect(settings).toMatch(
      /@media\s*\(max-width:\s*720px\)[\s\S]*?\.settings-layout\s*\{[^}]*grid-template-columns:\s*minmax\(0,\s*1fr\)/,
    )
    expect(settings).toMatch(
      /@media\s*\(max-width:\s*720px\)[\s\S]*?\.settings-navigation\s*\{[^}]*flex-direction:\s*row[^}]*overflow-x:\s*auto/,
    )
  })

  it("stacks option groups instead of squeezing controls", () => {
    expect(settings).toMatch(
      /@media\s*\(max-width:\s*720px\)[\s\S]*?\.settings-options--inline,[\s\S]*?\.settings-placeholder-options\s*\{[^}]*grid-template-columns:\s*minmax\(0,\s*1fr\)/,
    )
    expect(settings).toMatch(
      /@media\s*\(max-width:\s*720px\)[\s\S]*?\.compaction-settings__grid\s*\{[^}]*grid-template-columns:\s*minmax\(0,\s*1fr\)/,
    )
  })
})
