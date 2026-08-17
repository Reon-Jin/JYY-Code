import { describe, expect, test } from "bun:test"
import { paperLight, paperDark, tuiTheme, cssVars } from "../src/tokens"

describe("paperLight 与 desktop tokens.css 严格一致", () => {
  test("核心色值与 packages/app/src/styles/tokens.css 一致", () => {
    expect(paperLight.surface).toBe("#efede7")
    expect(paperLight.raised).toBe("#f7f5ef")
    expect(paperLight.control).toBe("#e7e4da")
    expect(paperLight.border).toBe("#dbd8ca")
    expect(paperLight.borderStrong).toBe("#c9c5b9")
    expect(paperLight.accent).toBe("#475a74")
    expect(paperLight.accentHover).toBe("#3a4a60")
    expect(paperLight.accentInk).toBe("#f8f7f3")
    expect(paperLight.text).toBe("#212428")
    expect(paperLight.textMuted).toBe("#686a6f")
    expect(paperLight.codeBg).toBe("#e9e6da")
    expect(paperLight.codeText).toBe("#2b2e33")
    expect(paperLight.danger).toBe("#9c4a3d")
    expect(paperLight.dangerSurface).toBe("#f6e9e5")
    expect(paperLight.dangerInk).toBe("#7c382c")
    expect(paperLight.warning).toBe("#775c2f")
    expect(paperLight.success).toBe("#40674f")
  })

  test("tuiTheme(paperLight) 生成合法 TUI theme JSON 结构", () => {
    const theme = tuiTheme(paperLight)
    expect(theme.defs!.accent).toBe("#475a74")
    expect(theme.defs!.bg).toBe("#efede7")
    expect(theme.defs!.text).toBe("#212428")
    expect(theme.defs!.textMuted).toBe("#686a6f")
    expect(theme.theme.primary).toBe("accent")
    expect(theme.theme.background).toBe("bg")
    expect(theme.theme.selectedListItemText).toBe("accentInk")
  })

  test("paperDark 是同一色族的深色变体（可读性：contrast ≥ 4.5）", () => {
    const theme = tuiTheme(paperDark)
    expect(theme.defs!.bg).not.toBe(paperLight.surface)
    const lum = (hex: string) => {
      const c = hex.slice(1)
      const [r, g, b] = [0, 2, 4].map((i) => parseInt(c.slice(i, i + 2), 16) / 255)
      const f = (v: number) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4)
      return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b)
    }
    const bg = lum(paperDark.surface)
    const fg = lum(paperDark.text)
    const contrast = (Math.max(bg, fg) + 0.05) / (Math.min(bg, fg) + 0.05)
    expect(contrast).toBeGreaterThanOrEqual(4.5)
  })
})

describe("cssVars 与 desktop CSS 变量命名一致", () => {
  test("产出 --surface-solid / --color-accent 等关键变量", () => {
    const vars = cssVars(paperLight)
    expect(vars["--surface-solid"]).toBe("#efede7")
    expect(vars["--surface-raised-solid"]).toBe("#f7f5ef")
    expect(vars["--color-accent"]).toBe("#475a74")
    expect(vars["--color-text"]).toBe("#212428")
    expect(vars["--color-text-muted"]).toBe("#686a6f")
  })
})
