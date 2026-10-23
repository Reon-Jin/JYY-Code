import { describe, expect, it } from "vitest"
import { clearMarkdownCache, loadMarkdownHighlighting, renderMarkdown, renderMarkdownBlocks } from "./markdown"

describe("renderMarkdown", () => {
  it.each(["complete", "streaming"] as const)("renders table cells and column alignment in %s mode", (mode) => {
    const source = "| Name | Count |\n| :--- | ---: |\n| **Images** | 4 |\n| Files | 5 |\n"
    const template = document.createElement("template")
    template.innerHTML = renderMarkdownBlocks(source, mode).join("")

    expect(template.content.querySelectorAll("table")).toHaveLength(1)
    expect(template.content.querySelectorAll("th")).toHaveLength(2)
    expect(template.content.querySelectorAll("tbody tr")).toHaveLength(2)
    expect(template.content.querySelectorAll("td")).toHaveLength(4)
    expect(template.content.querySelector("td strong")?.textContent).toBe("Images")
    expect(template.content.querySelector("th:last-child")?.getAttribute("align")).toBe("right")
    expect(template.content.querySelector("td:last-child")?.getAttribute("align")).toBe("right")
  })

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

  it("keeps web links keyboard accessible and marked for the controlled opener", () => {
    const html = renderMarkdown("[OpenAI](https://openai.com)")
    const template = document.createElement("template")
    template.innerHTML = html
    const link = template.content.querySelector("a")

    expect(link).not.toBeNull()
    expect(link?.getAttribute("rel")).toBe("noreferrer noopener")
    expect(link?.hasAttribute("aria-disabled")).toBe(false)
    expect(link?.getAttribute("data-external-href")).toBe("https://openai.com")
    expect(link?.getAttribute("href")).toBe("https://openai.com")
    expect(link?.getAttribute("target")).toBe("_blank")
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

  it.each(["complete", "streaming"] as const)("separates numbered math from its copy control in %s mode", (mode) => {
    const source = String.raw`\min_{B\in\mathbb{R}^{m\times n}}\|A-B\|_F\quad\text{s.t.}\quad\operatorname{rank}(B)\leq k.\tag{1}`
    const template = document.createElement("template")
    template.innerHTML = renderMarkdown(`$$\n${source}\n$$`, mode)
    const formula = template.content.querySelector(".markdown-math--display")!
    const content = formula.querySelector(".markdown-math__content")!
    const copy = formula.querySelector(".markdown-math__copy")!
    expect(content.querySelector(".tag")?.textContent).toBe("(1)")
    expect(content.contains(copy)).toBe(false)
    expect(content.nextElementSibling).toBe(copy)
    expect(formula.getAttribute("data-tex")?.trim()).toBe(source)
  })

  it.each(["complete", "streaming"] as const)("preserves complex math graphics in %s mode", (mode) => {
    const source = String.raw`\[
\begin{aligned}
f(x)&=\begin{cases}\sqrt{x^2+1}&x\ge 0\\-x&x<0\end{cases}\\
A&=\begin{pmatrix}a&b\\c&d\end{pmatrix}\\
I&=\int_0^\infty e^{-x^2}\,dx=\frac{\sqrt{\pi}}{2}
\end{aligned}
\]`
    const template = document.createElement("template")
    template.innerHTML = renderMarkdown(source, mode)
    expect(template.content.querySelector(".katex svg path")).not.toBeNull()
    expect(template.content.querySelector(".katex math")).not.toBeNull()
    expect(template.content.querySelector(".markdown-math-error")).toBeNull()
    expect(template.content.querySelector("[data-tex]")?.getAttribute("data-tex")).toContain("begin{aligned}")
  })

  it("recognizes all math delimiters without interpreting money or fenced code", () => {
    const html = renderMarkdown(
      String.raw`\(x^2\) and $2x$ and $$y=3$$

Price $20 and $30 today. Escaped \$40.

\[
\sum_{i=1}^{n}i=\frac{n(n+1)}{2}
\]

` + "```text\n$x$ and \\(y\\)\n```",
    )
    const template = document.createElement("template")
    template.innerHTML = html
    expect(template.content.querySelectorAll(".katex")).toHaveLength(4)
    expect(template.content.textContent).toContain("Price $20 and $30 today. Escaped $40.")
    expect(template.content.querySelector("code")?.textContent).toBe("$x$ and \\(y\\)")
  })

  it("keeps incomplete and invalid formulas readable without crashing", () => {
    const incomplete = renderMarkdown(String.raw`Before $\frac{a_1}{`, "streaming")
    expect(incomplete).toContain("markdown-math-pending")
    expect(incomplete).not.toContain("<em>")
    const invalid = renderMarkdown(String.raw`$\frac{$`)
    expect(invalid).toContain("markdown-math-error")
    expect(invalid).toContain("\\frac{")
    expect(renderMarkdown("$$" + "x".repeat(12_001) + "$$")).toContain("markdown-math-error")
  })

  it("renders footnotes, task lists, alerts and safe lazy images", () => {
    const html = renderMarkdown(
      "Text[^a]\n\n- [x] done\n\n> [!WARNING]\n> Keep this file.\n\n![sample](./image.png)\n\n[^a]: A **note**.",
    )
    const template = document.createElement("template")
    template.innerHTML = html
    expect(template.content.querySelector(".footnotes strong")?.textContent).toBe("note")
    expect(template.content.querySelector('a[href="#footnote-a"]')).not.toBeNull()
    expect(template.content.querySelector('input[type="checkbox"]')?.hasAttribute("checked")).toBe(true)
    expect(template.content.querySelector('.markdown-alert[data-kind="warning"]')).not.toBeNull()
    expect(template.content.querySelector("img")?.getAttribute("data-md-source")).toBe("./image.png")
    expect(template.content.querySelector("img")?.getAttribute("loading")).toBe("lazy")
    expect(template.content.querySelector("img")?.hasAttribute("src")).toBe(false)
  })

  it("only highlights closed code fences, with copy and fold controls", async () => {
    await loadMarkdownHighlighting()
    const code = '```python\ndef greet(name):\n    return "Hello " + name'
    const live = renderMarkdown(code, "streaming")
    expect(live).not.toContain("hljs-keyword")
    expect(renderMarkdown(code + "\n~~~", "streaming")).not.toContain("hljs-keyword")
    const complete = renderMarkdown(code + "\n```", "streaming")
    expect(complete).toContain("hljs-keyword")
    expect(complete).toContain('data-md-action="copy-code"')
    expect(complete).toContain('data-md-action="fold-code"')
    expect(renderMarkdown("```unknown-language\n<script>x</script>\n```")).not.toContain("<script>")
  })

  it("preserves local image references for the authenticated file resolver", () => {
    const html = renderMarkdown("![windows](C:/work/image.png)\n\n![uri](file:///C:/work/image.png)")
    const template = document.createElement("template")
    template.innerHTML = html
    expect([...template.content.querySelectorAll("img")].map((image) => image.dataset.mdSource)).toEqual([
      "C:/work/image.png",
      "file:///C:/work/image.png",
    ])
  })
})
