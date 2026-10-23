import { describe, expect, it } from "vitest"
import { gallerySections } from "./markdown-gallery-data"
import { renderMarkdown } from "../features/conversation/markdown"

describe("Markdown gallery samples", () => {
  it("keeps Chinese prose and math annotations as actual Unicode", () => {
    const source = gallerySections[3]!.source
    expect(source).toContain("行内公式")
    expect(source).toContain("\\text{ 项}")
    expect(source).not.toMatch(/\\u[0-9a-f]{4}/i)
    const html = renderMarkdown(source)
    expect(html).not.toContain("markdown-math-error")
    expect(html).not.toContain("markdown-math-pending")
    expect(html).not.toMatch(/\\u[0-9a-f]{4}/i)
  })
  it("only uses valid embedded images in the normal gallery", () => {
    const template = document.createElement("template")
    template.innerHTML = renderMarkdown(gallerySections[5]!.source)
    const images = [...template.content.querySelectorAll("img")]
    expect(images).toHaveLength(2)
    for (const image of images) {
      const source = image.dataset.mdSource!
      expect(source).toMatch(/^data:image\/svg\+xml,/)
      const svg = decodeURIComponent(source.slice(source.indexOf(",") + 1))
      expect(new DOMParser().parseFromString(svg, "image/svg+xml").querySelector("parsererror")).toBeNull()
    }
  })
})
