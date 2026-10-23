/** Patch sanitized markup while preserving unchanged text, selection and code scroll positions. */
export function patchMarkdown(host: HTMLElement, html: string) {
  const template = document.createElement("template")
  template.innerHTML = html
  patchChildren(host, template.content)
}

function patchChildren(parent: Node, next: Node) {
  let current = parent.firstChild
  for (const incoming of Array.from(next.childNodes)) {
    if (!current) {
      parent.appendChild(incoming.cloneNode(true))
      continue
    }
    const following = current.nextSibling
    if (current.nodeType !== incoming.nodeType || current.nodeName !== incoming.nodeName) {
      parent.replaceChild(incoming.cloneNode(true), current)
    } else if (current instanceof Text && incoming instanceof Text) {
      const before = current.data
      const after = incoming.data
      if (before !== after) {
        let prefix = 0
        while (prefix < before.length && prefix < after.length && before[prefix] === after[prefix]) prefix++
        current.replaceData(prefix, before.length - prefix, after.slice(prefix))
      }
    } else if (current instanceof Element && incoming instanceof Element && !current.isEqualNode(incoming)) {
      const sameImage =
        current.tagName === "IMG" && current.getAttribute("data-md-source") === incoming.getAttribute("data-md-source")
      const sameDiagram =
        current.hasAttribute("data-diagram-state") &&
        current.getAttribute("data-diagram-source") === incoming.getAttribute("data-diagram-source")
      if (sameDiagram) {
        current = following
        continue
      }
      const folding = current.getAttribute("data-md-action") === "fold-code"
      for (const attribute of Array.from(current.attributes)) {
        if (attribute.name === "data-md-collapsed" || (folding && attribute.name === "aria-expanded")) continue
        if (sameImage && ["src", "data-md-image-state", "aria-label", "alt"].includes(attribute.name)) continue
        if (!incoming.hasAttribute(attribute.name)) current.removeAttribute(attribute.name)
      }
      for (const attribute of Array.from(incoming.attributes)) {
        if (folding && attribute.name === "aria-expanded") continue
        if (sameImage && current.getAttribute("data-md-image-state") === "failed" && attribute.name === "alt") continue
        if (current.getAttribute(attribute.name) !== attribute.value)
          current.setAttribute(attribute.name, attribute.value)
      }
      if (!folding) patchChildren(current, incoming)
    }
    current = following
  }
  while (current) {
    const following = current.nextSibling
    parent.removeChild(current)
    current = following
  }
}
