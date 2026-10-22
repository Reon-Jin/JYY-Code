import { describe, expect, it } from "vitest"
import { clearMarkdownCache, renderMarkdown, renderMarkdownBlocks } from "./markdown"

describe("renderMarkdown", () => {
  it.each(["complete", "streaming"] as const)(
    "keeps block rendering equivalent to full rendering in %s mode",
    (mode) => {
      const source =
        "# Title\n\nFirst **bold** paragraph.\n\n- one\n- two\n\n> quote\n\n```ts\nconst x = 1\n```\n\n[link][ref]\n\n[ref]: https://example.com\n\nInline $x^2$\n\n$$\ny = x + 1\n$$\n"
      clearMarkdownCache()
      expect(renderMarkdownBlocks(source, mode).join("")).toBe(renderMarkdown(source, mode))
      expect(renderMarkdownBlocks(source, mode).join("")).toBe(renderMarkdown(source, mode))
    },
  )

  it("updates cached blocks when a reference definition arrives later", () => {
    const source = "[documentation][ref]\n\nTail"
    const before = renderMarkdownBlocks(source, "streaming").join("")
    const after = renderMarkdownBlocks(source + "\n\n[ref]: https://example.com\n", "streaming").join("")
    expect(before).not.toContain("data-external-href")
    expect(after).toContain('data-external-href="https://example.com"')
  })
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

  it("renders inline and display TeX formulas", () => {
    const html = renderMarkdown(String.raw`Inline $x = \frac{-b \pm \sqrt{b^2 - 4ac}}{2a}$

$$
\Delta = b^2 - 4ac
$$`)
    const template = document.createElement("template")
    template.innerHTML = html

    expect(template.content.querySelectorAll(".katex")).toHaveLength(2)
    expect(template.content.querySelector(".katex-display")).not.toBeNull()
    expect(template.content.querySelector(".katex math")).not.toBeNull()
    expect(template.content.querySelector(".katex [style]")).not.toBeNull()
  })

  it("renders Skill frontmatter as inert text without allowing raw HTML", () => {
    const html = renderMarkdown('---\nname: demo\n---\n\n# Skill\n<div onclick="alert(1)">unsafe</div>')

    expect(html).toContain("Skill")
    expect(html).not.toMatch(/onclick|<div/i)
  })
})
