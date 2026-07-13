import { describe, expect, it } from "vitest"
import { renderMarkdown } from "./markdown"

describe("renderMarkdown", () => {
  it("removes executable markup and dangerous containers", () => {
    const html = renderMarkdown(`
<script>alert(1)</script>
<img src="x" onerror="alert(1)" style="display:none">
<iframe src="https://example.com"></iframe>
<form action="https://example.com"><input name="secret"></form>
`)
    const unsafeLink = renderMarkdown("[bad](javascript:alert(1))")
    const template = document.createElement("template")
    template.innerHTML = unsafeLink

    expect(html).not.toMatch(/<script|onerror|style=|<iframe|<form/i)
    expect(template.content.querySelector("a")?.getAttribute("href") ?? "").not.toMatch(/^javascript:/i)
  })

  it("makes external links explicit and inert without an approved opener", () => {
    const html = renderMarkdown("[OpenAI](https://openai.com)")
    const template = document.createElement("template")
    template.innerHTML = html
    const link = template.content.querySelector("a")

    expect(link).not.toBeNull()
    expect(link?.getAttribute("rel")).toBe("noreferrer noopener")
    expect(link?.getAttribute("aria-disabled")).toBe("true")
    expect(link?.getAttribute("data-external-href")).toBe("https://openai.com")
    expect(link?.hasAttribute("href")).toBe(false)
  })
})
