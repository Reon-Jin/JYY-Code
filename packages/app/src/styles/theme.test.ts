import { readFileSync } from "node:fs"
import { describe, expect, it } from "vitest"

const sources = [
  "src/styles/tokens.css",
  "src/styles/global.css",
  "src/features/projects/projects.css",
  "src/features/management/management-shell.css",
  "src/features/sessions/sessions.css",
  "src/features/composer/composer.css",
  "src/features/conversation/conversation.css",
  "index.html",
  "../desktop/src-tauri/tauri.conf.json",
].map((path) => `${path}\n${readFileSync(path, "utf8")}`)

const themeSource = sources.join("\n")
const retiredPalette = [
  "#07111f",
  "#09192a",
  "#0b192b",
  "#10243a",
  "#14304b",
  "#22c997",
  "#36d9aa",
  "#031711",
  "#e7eef7",
  "#8da2b8",
  "#1a3148",
  "#28506f",
  "34 201 151",
  "40 80 111",
  "20 48 75",
  "16 36 58",
  "11 25 43",
  "7 17 31",
]

describe("Codex-inspired desktop theme", () => {
  it("uses a neutral near-black palette", () => {
    expect(themeSource).toContain("--surface-solid: #181818")
    expect(themeSource).toContain("--surface-raised-solid: #1f1f1f")
    expect(themeSource).toContain("--surface-control-solid: #262626")
    expect(themeSource).toContain("--color-accent: #f2f2f2")
    expect(themeSource).toContain('"backgroundColor": "#181818"')
  })

  it("does not retain the retired blue and green palette", () => {
    for (const color of retiredPalette) expect(themeSource.toLowerCase()).not.toContain(color)
  })

  it("defines the compact global management rail", () => {
    expect(themeSource).toContain("--management-rail-width: 60px")
    expect(themeSource).toContain("--management-nav-icon: 18px")
    expect(themeSource).toContain("max-width: 720px")
    expect(themeSource).toContain("--management-rail-width: 52px")
  })

  it("defines every semantic color token in dark and light themes", () => {
    const tokens = [
      "color-bg",
      "color-panel",
      "color-surface",
      "color-surface-hover",
      "color-header-surface",
      "color-accent",
      "color-accent-hover",
      "color-accent-ink",
      "color-text",
      "color-text-muted",
      "color-border",
      "color-border-strong",
      "color-danger",
      "color-danger-surface",
      "color-warning",
      "color-success",
      "color-overlay",
      "shadow-panel",
      "focus-ring",
    ]
    const dark = themeSource.match(/html\[data-theme="dark"\]\s*\{([\s\S]*?)\}/)?.[1] ?? ""
    const light = themeSource.match(/html\[data-theme="light"\]\s*\{([\s\S]*?)\}/)?.[1] ?? ""

    for (const token of tokens) {
      expect(dark).toContain(`--${token}:`)
      expect(light).toContain(`--${token}:`)
    }
    expect(dark).toContain("color-scheme: dark")
    expect(light).toContain("color-scheme: light")
  })

  it("themes the Session conversation header in light mode", () => {
    const sessions = readFileSync("src/features/sessions/sessions.css", "utf8")

    expect(sessions).toContain("background: var(--color-header-surface)")
    expect(sessions).not.toContain("background: rgb(24 24 24 / 88%)")
  })
})
