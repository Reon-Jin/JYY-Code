import { readFile, writeFile } from "node:fs/promises"
import { createRequire } from "node:module"
import { JSDOM } from "jsdom"
import { gallerySections } from "../src/dev/markdown-gallery-data"

const target = process.argv[2]
if (!target) throw new Error("Supply the existing preview fragment path")
const original = await readFile(target, "utf8")
const dom = new JSDOM("<!doctype html><html><body></body></html>")
Object.assign(globalThis, {
  window: dom.window,
  document: dom.window.document,
  Element: dom.window.Element,
  SVGElement: dom.window.SVGElement,
  CSSStyleSheet: dom.window.CSSStyleSheet,
  Node: dom.window.Node,
  HTMLElement: dom.window.HTMLElement,
  getComputedStyle: dom.window.getComputedStyle,
})
const { renderMarkdown, loadMarkdownHighlighting } = await import("../src/features/conversation/markdown")
await loadMarkdownHighlighting()
document.body.innerHTML = original
const root = document.getElementById("jyycode-markdown-preview")!
if (!root) throw new Error("Preview root is missing")

// Prefix selectors with the product root. @scope alone does not protect the
// sample from more specific table/text styles supplied by its conversation host.
const postcss = createRequire(import.meta.resolve("vite"))("postcss")
const stylesheet = postcss.parse(await readFile("src/features/conversation/conversation.css", "utf8"))
stylesheet.walkRules((rule) => {
  if (rule.parent?.type === "atrule" && /keyframes/i.test(rule.parent.name)) return
  rule.selectors = rule.selectors.map((selector) => `#jyycode-markdown-preview ${selector}`)
})
const style = root.querySelector("style")!
const custom = /#jyycode-markdown-preview\s*\{\s*padding: 20px;/.exec(style.textContent)
if (!custom) throw new Error("Preview control styles are missing")
const customStyles = style.textContent
  .slice(custom.index)
  .split("\n#jyycode-markdown-preview .conversation-markdown :is(table,")[0]
const tokens = (await readFile("src/styles/tokens.css", "utf8")).replaceAll(":root", "#jyycode-markdown-preview")
const textColor = /--color-text:\s*([^;]+);/.exec(tokens)?.[1]
if (!textColor) throw new Error("Missing product text color")
style.textContent =
  tokens +
  "\n" +
  stylesheet.toString() +
  "\n" +
  customStyles +
  `
#jyycode-markdown-preview .conversation-markdown :is(table, th, td),
#jyycode-markdown-preview .conversation-markdown :is(th, td) :is(code, strong, em, del) {
  color: var(--color-text) !important;
  -webkit-text-fill-color: var(--color-text) !important;
}`

const panels = root.querySelector(".sample-panels")!
panels.replaceChildren()
for (const [index, sample] of gallerySections.entries()) {
  const panel = document.createElement("section")
  panel.id = `md-panel-${index}`
  panel.className = "sample-panel conversation-markdown"
  panel.dataset.title = sample.title
  panel.setAttribute("role", "tabpanel")
  panel.setAttribute("aria-labelledby", `md-tab-${index}`)
  panel.hidden = index !== 0
  panel.innerHTML = renderMarkdown(sample.source)
  for (const cell of panel.querySelectorAll<HTMLElement>(
    "table, th, td, th code, td code, th strong, td strong, th em, td em, th del, td del",
  )) {
    cell.setAttribute("style", `color: ${textColor} !important; -webkit-text-fill-color: ${textColor} !important;`)
  }
  for (const image of panel.querySelectorAll<HTMLImageElement>("img[data-md-source]")) {
    image.src = image.dataset.mdSource!
  }
  panels.append(panel)
}

// The inline preview must not wait for an ESM/CDN import. Render its fixed
// example ahead of time using the production Mermaid renderer. Text geometry
// is supplied because jsdom has no font/layout engine; the graph layout is
// still computed by Mermaid/Dagre, not a separately drawn approximation.
Object.defineProperty(SVGElement.prototype, "getBBox", {
  configurable: true,
  value: () => ({ x: 0, y: 0, width: 120, height: 30 }),
})
Object.defineProperty(SVGElement.prototype, "getComputedTextLength", {
  configurable: true,
  value: function (this: SVGElement) {
    return (this.textContent?.length ?? 0) * 9
  },
})
const { renderDiagram } = await import("../src/features/conversation/markdown-diagram")
const graphs = root.querySelectorAll<HTMLElement>("[data-diagram-source]")
if (graphs.length !== 1) throw new Error("The rendered Markdown lost its diagram source")
for (const graph of graphs) {
  graph.innerHTML = (await renderDiagram(decodeURIComponent(graph.dataset.diagramSource!))).replaceAll(
    "chat-diagram-",
    "preview-chat-diagram-",
  )
  const svg = graph.querySelector("svg")!
  // Root getBBox is unavailable in jsdom. Fit the actual laid-out node boxes.
  const boxes = [...svg.querySelectorAll<SVGElement>(".node")].map((node) => {
    const position = /translate\(\s*([-\d.]+)[, ]+\s*([-\d.]+)\s*\)/.exec(node.getAttribute("transform") ?? "")
    const rect = node.querySelector("rect")
    if (!position || !rect) throw new Error("Missing graph geometry")
    return {
      x: Number(position[1]),
      y: Number(position[2]),
      w: Number(rect.getAttribute("width")),
      h: Number(rect.getAttribute("height")),
    }
  })
  if (boxes.length !== 6) throw new Error("Incomplete preview graph")
  const left = Math.min(...boxes.map((box) => box.x - box.w / 2)) - 24
  const top = Math.min(...boxes.map((box) => box.y - box.h / 2)) - 24
  const width = Math.max(...boxes.map((box) => box.x + box.w / 2)) + 24 - left
  const height = Math.max(...boxes.map((box) => box.y + box.h / 2)) + 24 - top
  svg.setAttribute("viewBox", `${left} ${top} ${width} ${height}`)
  svg.setAttribute("width", "100%")
  svg.setAttribute("height", String(height))
  svg.style.maxWidth = `${width}px`
  svg.setAttribute("role", "img")
  svg.setAttribute("aria-label", "用户输入经 Markdown 解析后分为数学公式、代码高亮、图片与链接，最终稳定显示")
  graph.dataset.diagramState = "ready"
}
for (const script of root.querySelectorAll('script[type="module"]')) script.remove()

const result = document.body.innerHTML
if (/\\u[0-9a-f]{4}/i.test(root.querySelector("#md-panel-3")!.textContent))
  throw new Error("Escaped Unicode in formula sample")
if (Buffer.byteLength(result) > 1_000_000) throw new Error("Inline preview is too large")
await writeFile(target, result)
console.log(`Updated inline preview: ${Buffer.byteLength(result)} bytes; graph ready; two valid images`)
