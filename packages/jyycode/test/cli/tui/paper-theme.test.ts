import { expect, test } from "bun:test"
import { paperLight, paperDark, tuiTheme } from "@jyycode-ai/design-tokens"
import { DEFAULT_THEMES, DEFAULT_ACTIVE_THEME, resolveTheme } from "../../../src/cli/cmd/tui/context/theme"

test("默认激活主题为 paper 且已注册", () => {
  expect(DEFAULT_ACTIVE_THEME).toBe("paper")
  expect(DEFAULT_THEMES[DEFAULT_ACTIVE_THEME]).toBeDefined()
  // jyycode 主题仍保留可切换
  expect(DEFAULT_THEMES.jyycode).toBeDefined()
})

test("paper 主题已注册为内置主题", () => {
  expect(DEFAULT_THEMES.paper).toBeDefined()
})

test("paper light 解析结果与 desktop paper 色值精确一致", () => {
  const expected = tuiTheme(paperLight)
  const resolved = resolveTheme(DEFAULT_THEMES.paper, "light")
  expect(resolved.primary.r).toBeCloseTo(0x47 / 255, 3)
  expect(resolved.primary.g).toBeCloseTo(0x5a / 255, 3)
  expect(resolved.primary.b).toBeCloseTo(0x74 / 255, 3)
  expect(resolved.background.r).toBeCloseTo(0xef / 255, 3)
  expect(resolved.background.g).toBeCloseTo(0xed / 255, 3)
  expect(resolved.background.b).toBeCloseTo(0xe7 / 255, 3)
  expect(resolved.text.r).toBeCloseTo(0x21 / 255, 3)
  expect(resolved.textMuted.g).toBeCloseTo(0x6a / 255, 3)
  expect(resolved.selectedListItemText.r).toBeCloseTo(0xf8 / 255, 3)
  // 生成器语义与 tokens 包一致：defs 锚定同一组 hex
  expect(expected.defs!.accent).toBe(paperLight.accent)
  expect(expected.defs!.bg).toBe(paperLight.surface)
})

test("paper 主题含 dark/light 双变体", () => {
  const dark = resolveTheme(DEFAULT_THEMES.paper, "dark")
  const light = resolveTheme(DEFAULT_THEMES.paper, "light")
  expect(dark.background.r).toBeLessThan(light.background.r)
  expect(dark.text.r).toBeGreaterThan(light.text.r)
  expect(paperDark.accent).not.toBe(paperLight.accent)
})
