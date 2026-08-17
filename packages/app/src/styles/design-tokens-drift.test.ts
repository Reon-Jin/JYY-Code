import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { resolve } from "node:path"
import { describe, expect, test } from "vitest"
import { paperLight, cssVars } from "@jyycode-ai/design-tokens"

const css = readFileSync(resolve(fileURLToPath(import.meta.url), "../tokens.css"), "utf8")

describe("tokens.css 与 @jyycode-ai/design-tokens 无漂移", () => {
  test("每个颜色变量都与单一 token 源一致", () => {
    for (const [name, value] of Object.entries(cssVars(paperLight))) {
      const re = new RegExp(`${name}:\\s*([^;]+);`)
      const match = css.match(re)
      expect(match, `tokens.css 缺少变量 ${name}`).toBeTruthy()
      expect(match![1]!.trim(), `变量 ${name} 与 token 源不一致`).toBe(value)
    }
  })
})
