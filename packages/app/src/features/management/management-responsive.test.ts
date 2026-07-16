import { readFileSync } from "node:fs"
import { describe, expect, it } from "vitest"

const shell = readFileSync("src/features/management/management-shell.css", "utf8")
const projects = readFileSync("src/features/projects/projects.css", "utf8")
const global = readFileSync("src/styles/global.css", "utf8")

describe("management responsive CSS contract", () => {
  it("uses the approved rail dimensions and compact icons", () => {
    expect(shell).toMatch(/--management-rail-width:\s*60px/)
    expect(shell).toMatch(/--management-nav-icon:\s*18px/)
    expect(shell).toMatch(/@media\s*\(max-width:\s*720px\)[\s\S]*--management-rail-width:\s*52px/)
  })

  it("keeps 1024 by 720 content scrollable", () => {
    expect(shell).toMatch(/\.management-shell__content\s*\{[\s\S]*?overflow:\s*auto/)
    expect(projects).toMatch(/\.welcome-page\s*\{[\s\S]*?overflow:\s*auto/)
  })

  it("stacks project actions before either card becomes narrower than 240px", () => {
    expect(projects).toMatch(/grid-template-columns:\s*repeat\(2,\s*minmax\(240px,\s*1fr\)\)/)
    expect(projects).toMatch(
      /@media\s*\(max-width:\s*620px\)[\s\S]*?\.welcome-actions\s*\{[\s\S]*?grid-template-columns:\s*1fr/,
    )
  })

  it("honors reduced motion preferences", () => {
    expect(global).toMatch(/@media\s*\(prefers-reduced-motion:\s*reduce\)/)
    expect(global).toMatch(/transition-duration:\s*0\.01ms/)
  })
})
