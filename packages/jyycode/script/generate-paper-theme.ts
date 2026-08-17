// 生成 TUI paper 内置主题（一次生成、结果入库，避免 TUI 运行时依赖 tokens 包）
// 运行：bun run --cwd packages/jyycode script/generate-paper-theme.ts
import { writeFileSync } from "node:fs"
import { resolve } from "node:path"
import { paperLight, paperDark, tuiTheme } from "@jyycode-ai/design-tokens"

const light = tuiTheme(paperLight)
const dark = tuiTheme(paperDark)

// 把 theme 条目里的 defs 引用解析为实际 hex，再把 light/dark 差异内联为 { dark, light } 变体。
function resolveRef(value: string, defs: Record<string, string>): string {
  if (value.startsWith("#")) return value
  const next = defs[value]
  if (!next) throw new Error(`无法解析主题引用 "${value}"`)
  return next
}

const merged = {
  $schema: "https://jyycode.ai/theme.json",
  theme: Object.fromEntries(
    Object.keys(light.theme).map((key) => {
      const l = light.theme[key] as string
      const d = dark.theme[key] as string
      if (typeof l !== "string" || typeof d !== "string") return [key, l]
      const lh = resolveRef(l, light.defs ?? {})
      const dh = resolveRef(d, dark.defs ?? {})
      return [key, lh === dh ? lh : { dark: dh, light: lh }]
    }),
  ),
}
writeFileSync(resolve(import.meta.dir, "../src/cli/cmd/tui/context/theme/paper.json"), JSON.stringify(merged, null, 2) + "\n")
console.log("paper.json written")
