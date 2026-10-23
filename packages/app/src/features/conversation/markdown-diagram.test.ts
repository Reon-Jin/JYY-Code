import { afterEach, describe, expect, it } from "vitest"
import { renderDiagram } from "./markdown-diagram"
import { renderMarkdown } from "./markdown"

afterEach(() => {
  document.body.replaceChildren()
  delete (SVGElement.prototype as unknown as Record<string, unknown>).getBBox
  delete (SVGElement.prototype as unknown as Record<string, unknown>).getComputedTextLength
})

describe("Markdown diagrams", () => {
  it("renders a real flowchart and strips navigation and executable SVG", async () => {
    // jsdom has no font/layout engine; only supply geometry for Mermaid's layout.
    Object.defineProperty(SVGElement.prototype, "getBBox", {
      configurable: true,
      value: () => ({ x: 0, y: 0, width: 120, height: 30 }),
    })
    Object.defineProperty(SVGElement.prototype, "getComputedTextLength", {
      configurable: true,
      value: function (this: SVGElement) {
        return (this.textContent?.length ?? 0) * 8
      },
    })
    const source = "flowchart LR\n  A[Input] --> B[Output]"
    const markdown = document.createElement("div")
    markdown.innerHTML = renderMarkdown("```mermaid\n" + source + "\n```")
    const graph = markdown.querySelector<HTMLElement>("[data-diagram-source]")
    expect(graph).not.toBeNull()
    expect(decodeURIComponent(graph!.dataset.diagramSource!)).toBe(source)
    const html = await renderDiagram(decodeURIComponent(graph!.dataset.diagramSource!))
    const host = document.createElement("div")
    host.innerHTML = html
    expect(host.querySelector("svg")).not.toBeNull()
    expect(host.textContent).toContain("Input")
    expect(host.textContent).toContain("Output")
    expect(host.querySelector("script, foreignObject, a, image")).toBeNull()
  })
  it("rejects invalid or excessive diagram sources", async () => {
    await expect(renderDiagram("not a valid diagram")).rejects.toThrow()
    await expect(renderDiagram("x".repeat(12_001))).rejects.toThrow("Diagram is too long")
  })
})
