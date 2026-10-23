import DOMPurify from "dompurify"
import mermaid from "mermaid"

mermaid.initialize({
  startOnLoad: false,
  securityLevel: "strict",
  theme: "neutral",
  htmlLabels: false,
  suppressErrorRendering: true,
  maxTextSize: 12_000,
  flowchart: { htmlLabels: false },
})
let sequence = 0

export async function renderDiagram(source: string) {
  if (source.length > 12_000) throw new Error("Diagram is too long")
  const { svg } = await mermaid.render(`chat-diagram-${++sequence}`, source)
  return DOMPurify.sanitize(svg, {
    USE_PROFILES: { svg: true, svgFilters: true },
    FORBID_TAGS: ["foreignObject", "a", "script", "image", "use"],
    FORBID_ATTR: ["href", "xlink:href"],
  })
}
