import DOMPurify from "dompurify"
import "katex/dist/katex.min.css"
import { Marked } from "marked"
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

const MARKDOWN_CACHE_LIMIT = 64
const renderedCache = new Map<string, string>()

function cachedResult(key: string) {
  const value = renderedCache.get(key)
  if (value === undefined) return undefined
  renderedCache.delete(key)
  renderedCache.set(key, value)
  return value
}

function rememberResult(key: string, value: string) {
  renderedCache.delete(key)
  renderedCache.set(key, value)
  while (renderedCache.size > MARKDOWN_CACHE_LIMIT) renderedCache.delete(renderedCache.keys().next().value!)
}

export function clearMarkdownCache() {
  renderedCache.clear()
}

export function renderMarkdown(source: string, mode: MarkdownRenderMode = "complete") {
  const cacheKey = `${mode}\u0000${source}`
  const previous = cachedResult(cacheKey)
  if (previous !== undefined) return previous

  const parser = mode === "streaming" ? streamingMarkdown : markdown
  const html = parser.parse(source, { async: false }) as string
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

  const result = template.innerHTML
  rememberResult(cacheKey, result)
  return result
}
