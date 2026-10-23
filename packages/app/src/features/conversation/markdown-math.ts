import katex from "katex"
import { tr } from "../../i18n/i18n-context"
import type { MarkedExtension } from "marked"

export function escapeMarkup(value: string) {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;")
}

function mathToken(source: string, block: boolean) {
  const open = block ? /^(\$\$|\\\[)/.exec(source)?.[0] : /^(\$\$?|\\\(|\\\[)/.exec(source)?.[0]
  if (!open) return undefined
  const display = open === "$$" || open === "\\["
  if (!block && open === "$" && (/\s/.test(source[1] ?? " ") || source[1] === "$")) return undefined
  const close = open === "\\(" ? "\\)" : open === "\\[" ? "\\]" : open
  let end = open.length
  for (; end < source.length; end++) {
    if (open === "$" && source[end] === "\n") break
    if (!source.startsWith(close, end)) continue
    let escapes = 0
    for (let i = end - 1; i >= 0 && source[i] === "\\"; i--) escapes++
    if (escapes % 2) continue
    if (open === "$" && (/\s/.test(source[end - 1] ?? " ") || /\d/.test(source[end + 1] ?? ""))) return undefined
    const text = source.slice(open.length, end)
    if (!text.trim()) return undefined
    return { type: block ? "displayMath" : "inlineMath", raw: source.slice(0, end + close.length), text, display }
  }
  // Keep unfinished notation readable without interpreting its Markdown punctuation.
  if (end === source.length && (display || open === "\\(" || !/^\$\d/.test(source))) {
    return { type: block ? "displayMath" : "inlineMath", raw: source, text: source, display, pending: true }
  }
  return undefined
}

export function mathExtension(): MarkedExtension {
  return {
    extensions: (["block", "inline"] as const).map((level) => ({
      name: level === "block" ? "displayMath" : "inlineMath",
      level,
      start(source: string) {
        const match = level === "block" ? /(?:^|\n)(\$\$|\\\[)/.exec(source) : /\$|\\[([]/.exec(source)
        return match ? match.index + (match[0].startsWith("\n") ? 1 : 0) : undefined
      },
      tokenizer(source: string) {
        return mathToken(source, level === "block")
      },
      renderer(token) {
        const tag = token.type === "displayMath" ? "div" : "span"
        if (token.pending) return `<${tag} class="markdown-math-pending">${escapeMarkup(token.raw)}</${tag}>`
        let html: string
        try {
          if (token.text.length > 12_000) throw new Error("Formula is too long")
          html = katex.renderToString(token.text, {
            displayMode: token.display,
            throwOnError: true,
            strict: "ignore",
            trust: false,
            maxExpand: 1000,
            maxSize: 20,
          })
        } catch {
          return `<${tag} class="markdown-math-error" title="${escapeMarkup(tr("conversation.md-math-failed"))}">${escapeMarkup(token.raw)}</${tag}>`
        }
        const copy = token.display
          ? `<button type="button" data-md-action="copy-math" class="markdown-math__copy">${escapeMarkup(tr("conversation.md-copy-math"))}</button>`
          : ""
        const content = token.display ? `<span class="markdown-math__content">${html}</span>${copy}` : html
        return `<${tag} class="markdown-math${token.display ? " markdown-math--display" : ""}" data-tex="${escapeMarkup(token.text)}">${content}</${tag}>`
      },
    })),
  }
}
