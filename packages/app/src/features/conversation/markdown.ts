import DOMPurify from "dompurify"
import "katex/dist/katex.min.css"
import { Marked, type TokensList } from "marked"
import markedKatex from "marked-katex-extension"

const markdown = new Marked(markedKatex({ throwOnError: false, nonStandard: true, strict: "ignore", trust: false }), {
  renderer: {
    // Raw HTML is intentionally unsupported. This keeps user-authored styles
    // out while allowing the trusted KaTeX renderer to retain layout styles.
    html: () => "",
  },
})
const streamingMarkdown = new Marked({
  renderer: {
    html: () => "",
  },
})

export type MarkdownRenderMode = "complete" | "streaming"

const MARKDOWN_CACHE_LIMIT = 256
const MARKDOWN_CACHE_BYTES = 2 * 1024 * 1024
const renderedCache = new Map<string, string>()
let cachedBytes = 0

function cachedResult(key: string) {
  const value = renderedCache.get(key)
  if (value === undefined) return undefined
  renderedCache.delete(key)
  renderedCache.set(key, value)
  return value
}

function rememberResult(key: string, value: string) {
  const bytes = (key.length + value.length) * 2
  if (bytes > MARKDOWN_CACHE_BYTES / 4) return
  const previous = renderedCache.get(key)
  if (previous !== undefined) cachedBytes -= (key.length + previous.length) * 2
  renderedCache.delete(key)
  renderedCache.set(key, value)
  cachedBytes += bytes
  while (renderedCache.size > MARKDOWN_CACHE_LIMIT || cachedBytes > MARKDOWN_CACHE_BYTES) {
    const oldest = renderedCache.keys().next().value!
    cachedBytes -= (oldest.length + renderedCache.get(oldest)!.length) * 2
    renderedCache.delete(oldest)
  }
}

export function clearMarkdownCache() {
  renderedCache.clear()
  cachedBytes = 0
}

export function renderMarkdown(source: string, mode: MarkdownRenderMode = "complete") {
  const cacheKey = `${mode}\u0000${source}`
  const previous = cachedResult(cacheKey)
  if (previous !== undefined) return previous

  const parser = mode === "streaming" ? streamingMarkdown : markdown
  const html = parser.parse(source, { async: false }) as string
  const result = sanitizeMarkdown(html)
  if (mode === "complete") rememberResult(cacheKey, result)
  return result
}

function sanitizeMarkdown(html: string) {
  const sanitized = DOMPurify.sanitize(html, {
    USE_PROFILES: { html: true, mathMl: true },
    FORBID_TAGS: ["style", "iframe", "object", "embed", "form"],
    FORBID_ATTR: ["srcset"],
  })
  const template = document.createElement("template")
  template.innerHTML = sanitized

  for (const link of template.content.querySelectorAll<HTMLAnchorElement>("a")) {
    const href = link.getAttribute("href")
    if (!href || (!href.startsWith("http://") && !href.startsWith("https://"))) continue
    link.setAttribute("rel", "noreferrer noopener")
    link.setAttribute("aria-disabled", "true")
    link.dataset.externalHref = href
    link.removeAttribute("href")
  }

  return template.innerHTML
}

/** Retain completed blocks; only the live tail needs parsing and DOM updates. */
export function renderMarkdownBlocks(source: string, mode: MarkdownRenderMode): string[] {
  const parser = mode === "streaming" ? streamingMarkdown : markdown
  const tokens = parser.lexer(source)
  // Reference definitions can arrive later and change earlier links. Include
  // their context so a stable block never freezes an unresolved reference.
  const links = JSON.stringify(tokens.links)
  return tokens.flatMap((token, index) => {
    const cacheKey = `block:${mode}\u0000${links}\u0000${token.raw}`
    const cached = cachedResult(cacheKey)
    if (cached !== undefined) return cached ? [cached] : []
    const block = Object.assign([token], { links: tokens.links }) as TokensList
    const html = sanitizeMarkdown(parser.parser(block))
    if (mode === "complete" || index < tokens.length - 1) rememberResult(cacheKey, html)
    return html ? [html] : []
  })
}
