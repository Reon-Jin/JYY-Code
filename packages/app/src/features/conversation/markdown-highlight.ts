import hljs from "highlight.js/lib/common"
import { escapeMarkup } from "./markdown-math"

export function highlight(source: string, language: string) {
  if (source.length > 50_000 || !hljs.getLanguage(language)) return escapeMarkup(source)
  return hljs.highlight(source, { language, ignoreIllegals: true }).value
}
