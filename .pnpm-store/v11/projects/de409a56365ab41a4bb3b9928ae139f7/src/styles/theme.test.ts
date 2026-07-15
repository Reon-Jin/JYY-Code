import { readFileSync } from "node:fs"
import { describe, expect, it } from "vitest"

const sources = [
  "src/styles/tokens.css",
  "src/styles/global.css",
  "src/features/projects/projects.css",
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
    expect(themeSource).toContain("--color-bg: #181818")
    expect(themeSource).toContain("--color-panel: #1f1f1f")
    expect(themeSource).toContain("--color-surface: #262626")
    expect(themeSource).toContain("--color-accent: #f2f2f2")
    expect(themeSource).toContain('"backgroundColor": "#181818"')
  })

  it("does not retain the retired blue and green palette", () => {
    for (const color of retiredPalette) expect(themeSource.toLowerCase()).not.toContain(color)
  })
})
