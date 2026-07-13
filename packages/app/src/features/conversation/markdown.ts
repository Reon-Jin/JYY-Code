import DOMPurify from "dompurify"
import { marked } from "marked"

export function renderMarkdown(source: string) {
  const html = marked.parse(source, { async: false }) as string
  const sanitized = DOMPurify.sanitize(html, {
    USE_PROFILES: { html: true },
    FORBID_TAGS: ["style", "iframe", "object", "embed", "form"],
    FORBID_ATTR: ["style", "srcset"],
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
