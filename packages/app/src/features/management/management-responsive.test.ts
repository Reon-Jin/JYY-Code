import { readFileSync } from "node:fs"
import { describe, expect, it } from "vitest"

const shell = readFileSync("src/features/management/management-shell.css", "utf8")
const projects = readFileSync("src/features/projects/projects.css", "utf8")
const mcp = readFileSync("src/features/mcp/mcp-management.css", "utf8")
const skills = readFileSync("src/features/skills/skills.css", "utf8")
const global = readFileSync("src/styles/global.css", "utf8")
const settings = readFileSync("src/features/settings/settings.css", "utf8")

describe("management responsive CSS contract", () => {
  it("uses the approved rail dimensions and compact icons", () => {
    expect(shell).toMatch(/--management-rail-width:\s*60px/)
    expect(shell).toMatch(/--management-nav-icon:\s*18px/)
    expect(shell).toMatch(/@media\s*\(max-width:\s*720px\)[\s\S]*--management-rail-width:\s*52px/)
  })

  it("keeps 1024 by 720 content scrollable", () => {
    expect(shell).toMatch(/\.management-shell__content\s*\{[\s\S]*?overflow:\s*auto/)
    expect(projects).toMatch(/\.welcome-page\s*\{[\s\S]*?overflow:\s*auto/)
    expect(settings).toMatch(/\.settings-content\s*\{[\s\S]*?overflow:\s*auto/)
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

  it("uses visible theme colors for MCP switches and form controls", () => {
    expect(mcp).toMatch(/\.mcp-management__switch\[data-active="true"\]\s*\{[^}]*background:\s*var\(--color-accent\)/s)
    expect(mcp).toMatch(
      /\.mcp-config-form input,[\s\S]*?\.mcp-config-form select\s*\{[^}]*border:\s*1px solid var\(--color-border-strong\)/s,
    )
    expect(mcp).toMatch(
      /\.mcp-config-form option\s*\{[^}]*background:\s*var\(--color-panel\)[^}]*color:\s*var\(--color-text\)/s,
    )
    expect(mcp).not.toMatch(/var\(--(?:text|border|surface|accent)-(?!color)/)
  })

  it("keeps Skill detail actions at the standard button size", () => {
    expect(skills).toMatch(/\.skill-detail__actions\s*\{[^}]*flex:\s*0 0 auto/s)
    expect(skills).toMatch(/\.skill-detail__actions \.ui-button\s*\{[^}]*white-space:\s*nowrap/s)
  })
})
