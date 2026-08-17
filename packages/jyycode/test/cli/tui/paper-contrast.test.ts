import { describe, expect, test } from "bun:test"
import { paperLight, paperDark } from "@jyycode-ai/design-tokens"
import { DEFAULT_THEMES, resolveTheme } from "../../../src/cli/cmd/tui/context/theme"
import { contrast, contrastHex } from "../../../src/cli/cmd/tui/util/contrast"

const pairs = ["light", "dark"] as const

describe("paper 主题对比度", () => {
  for (const mode of pairs) {
    test(`${mode}: 正文/注释/链接/语法高亮均满足可读对比度`, () => {
      const theme = resolveTheme(DEFAULT_THEMES.paper, mode)
      const bg = theme.background
      const checks: Array<[string, number, number]> = [
        ["text", theme.text, 4.5],
        ["textMuted", theme.textMuted, 3],
        ["primary", theme.primary, 3],
        ["syntaxKeyword", theme.syntaxKeyword, 3],
        ["syntaxFunction", theme.syntaxFunction, 3],
        ["syntaxString", theme.syntaxString, 3],
        ["syntaxNumber", theme.syntaxNumber, 3],
      ]
      for (const [name, color, min] of checks) {
        expect(contrast(bg, color), `${mode}/${name} 对比度不足`).toBeGreaterThanOrEqual(min)
      }
    })

    test(`${mode}: 语义色（error/warning/success）在面板背景上可辨`, () => {
      const theme = resolveTheme(DEFAULT_THEMES.paper, mode)
      const panel = theme.backgroundPanel
      for (const [name, color] of [
        ["error", theme.error],
        ["warning", theme.warning],
        ["success", theme.success],
      ] as const) {
        expect(contrast(panel, color), `${mode}/${name} 对比度不足`).toBeGreaterThanOrEqual(3)
      }
    })
  }

  test("token 源 light/dark 核心对与 resolved 一致", () => {
    expect(contrastHex(paperLight.text, paperLight.surface)).toBeGreaterThanOrEqual(4.5)
    expect(contrastHex(paperDark.text, paperDark.surface)).toBeGreaterThanOrEqual(4.5)
  })
})
