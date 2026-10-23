import DOMPurify from "dompurify"
import { tr } from "../../i18n/i18n-context"
import "katex/dist/katex.min.css"
import { Marked, type Tokens, type TokensList } from "marked"
import markedFootnote from "marked-footnote"
import { escapeMarkup, mathExtension } from "./markdown-math"

let highlighter: typeof import("./markdown-highlight") | undefined
let highlighting: Promise<void> | undefined

export function loadMarkdownHighlighting() {
  return (highlighting ??= import("./markdown-highlight").then((module) => {
    highlighter = module
    clearMarkdownCache()
  }))
}

function createParser() {
  return new Marked(
    mathExtension(),
    markedFootnote({ description: "Footnotes", headingClass: "", backRefLabel: "Back to reference {0}" }),
    {
      renderer: {
        // User HTML stays disabled; markup is produced only by trusted renderers.
        html: () => "",
        image({ href, text, title }) {
          return `<img data-md-source="${escapeMarkup(href)}" alt="${escapeMarkup(text)}"${title ? ` title="${escapeMarkup(title)}"` : ""}>`
        },
        code(token: Tokens.Code) {
          const language = token.lang?.split(/\s/)[0]?.toLowerCase() ?? "text"
          const lines = token.raw.trimEnd().split("\n")
          const opening = /^ {0,3}(`{3,}|~{3,})/.exec(lines[0] ?? "")?.[1]
          const closed =
            token.codeBlockStyle === "indented" ||
            Boolean(
              opening &&
                lines.length > 1 &&
                new RegExp(`^ {0,3}${opening[0]}{${opening.length},}[ \\t]*$`).test(lines.at(-1)!),
            )
          const code = escapeMarkup(token.text)
          const content = closed ? (highlighter?.highlight(token.text, language) ?? code) : code
          const diagram =
            language === "mermaid" && closed
              ? `<div class="markdown-diagram" data-diagram-source="${encodeURIComponent(token.text)}"><span class="markdown-diagram__status">${escapeMarkup(tr("conversation.md-diagram-loading"))}</span></div>`
              : ""
          return `<figure class="markdown-code" data-language="${escapeMarkup(language)}"><figcaption><span>${escapeMarkup(language)}</span><span class="markdown-code__actions"><button type="button" data-md-action="copy-code">${escapeMarkup(tr("conversation.md-copy-code"))}</button><button type="button" data-md-action="fold-code" aria-expanded="true">${escapeMarkup(tr("conversation.md-fold-code"))}</button></span></figcaption>${diagram}<pre tabindex="0"><code>${content}</code></pre></figure>`
        },
        blockquote({ tokens }) {
          const html = this.parser.parse(tokens)
          const marker = /^<p>\[!(NOTE|TIP|IMPORTANT|WARNING|CAUTION)\](?:\n|<br>)/i.exec(html)
          if (!marker) return `<blockquote>${html}</blockquote>`
          const kind = marker[1]!.toLowerCase()
          return `<aside class="markdown-alert" data-kind="${kind}"><strong class="markdown-alert__title">${marker[1]}</strong>${html.replace(marker[0], "<p>")}</aside>`
        },
      },
    },
  )
}
const markdown = createParser()

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
  const cacheKey = `${tr("conversation.md-copy-code")}\u0000${mode}\u0000${source}`
  const previous = cachedResult(cacheKey)
  if (previous !== undefined) return previous

  const result = renderMarkdownBlocks(source, mode).join("")
  if (mode === "complete") rememberResult(cacheKey, result)
  return result
}

function sanitizeMarkdown(html: string) {
  const sanitized = DOMPurify.sanitize(html, {
    USE_PROFILES: { html: true, mathMl: true, svg: true },
    FORBID_TAGS: ["style", "iframe", "object", "embed", "form", "foreignObject", "animate", "set", "use"],
    FORBID_ATTR: ["srcset"],
  })
  const template = document.createElement("template")
  template.innerHTML = sanitized

  for (const link of template.content.querySelectorAll<HTMLAnchorElement>("a")) {
    const href = link.getAttribute("href")
    if (!href || !/^https?:\/\//i.test(href)) continue
    link.setAttribute("rel", "noreferrer noopener")
    link.dataset.externalHref = href
    link.setAttribute("target", "_blank")
  }

  for (const image of template.content.querySelectorAll("img")) {
    image.dataset.mdSource = image.dataset.mdSource ?? image.getAttribute("src") ?? ""
    image.removeAttribute("src")
    image.setAttribute("loading", "lazy")
    image.setAttribute("decoding", "async")
    image.setAttribute("tabindex", "0")
    image.setAttribute("role", "button")
  }
  for (const svg of template.content.querySelectorAll("svg")) {
    if (!svg.closest(".katex")) svg.remove()
  }
  for (const heading of template.content.querySelectorAll(".footnotes > h2"))
    heading.textContent = tr("conversation.md-footnotes")
  for (const backref of template.content.querySelectorAll("[data-footnote-backref]")) {
    const label = backref.closest("li")?.id.replace(/^footnote-/, "") ?? ""
    backref.setAttribute("aria-label", tr("conversation.md-backref", { label }))
  }
  return template.innerHTML
}

/** Retain completed blocks; only the live tail needs parsing and DOM updates. */
export function renderMarkdownBlocks(source: string, mode: MarkdownRenderMode): string[] {
  const parser = markdown
  const tokens = parser.lexer(source)
  if (parser.defaults.walkTokens) void parser.walkTokens(tokens, parser.defaults.walkTokens)
  const footnotes = source.includes("[^") ? source : ""
  // Reference definitions can arrive later and change earlier links. Include
  // their context so a stable block never freezes an unresolved reference.
  const links = tr("conversation.md-copy-code") + JSON.stringify(tokens.links)
  return tokens.flatMap((token, index) => {
    const cacheKey = `block:\u0000${links}\u0000${footnotes}\u0000${token.raw}`
    const cached = cachedResult(cacheKey)
    if (cached !== undefined) return cached ? [cached] : []
    const block = Object.assign([token], { links: tokens.links }) as TokensList
    const html = sanitizeMarkdown(parser.parser(block))
    if (mode === "complete" || index < tokens.length - 1) rememberResult(cacheKey, html)
    return html ? [html] : []
  })
}
