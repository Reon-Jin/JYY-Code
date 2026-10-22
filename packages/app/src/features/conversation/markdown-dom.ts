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
      for (const attribute of Array.from(current.attributes)) {
        if (!incoming.hasAttribute(attribute.name)) current.removeAttribute(attribute.name)
      }
      for (const attribute of Array.from(incoming.attributes)) {
        if (current.getAttribute(attribute.name) !== attribute.value)
          current.setAttribute(attribute.name, attribute.value)
      }
      patchChildren(current, incoming)
    }
    current = following
  }
  while (current) {
    const following = current.nextSibling
    parent.removeChild(current)
    current = following
  }
}
