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

export function renderMarkdown(source: string) {
  const html = markdown.parse(source, { async: false }) as string
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
