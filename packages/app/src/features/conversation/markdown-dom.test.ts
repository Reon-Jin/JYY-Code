import { describe, expect, it } from "vitest"
import { patchMarkdown } from "./markdown-dom"

describe("incremental Markdown DOM", () => {
  it("preserves earlier blocks, code scroll position and selection during tail updates", () => {
    const host = document.createElement("div")
    document.body.append(host)
    patchMarkdown(host, "<p>Selected text</p><pre><code>long code</code></pre><p>Live</p>")
    const first = host.firstChild!
    const pre = host.querySelector("pre")!
    const tail = host.lastChild!.firstChild!
    pre.scrollLeft = 42
    const range = document.createRange()
    range.setStart(first.firstChild!, 0)
    range.setEnd(first.firstChild!, 8)
    const selection = window.getSelection()!
    selection.removeAllRanges()
    selection.addRange(range)
    patchMarkdown(host, "<p>Selected text</p><pre><code>long code</code></pre><p>Live text</p>")
    expect(host.firstChild).toBe(first)
    expect(host.querySelector("pre")).toBe(pre)
    expect(pre.scrollLeft).toBe(42)
    expect(host.lastChild!.firstChild).toBe(tail)
    expect(selection.toString()).toBe("Selected")
    host.remove()
    selection.removeAllRanges()
  })

  it("corrects changed structure and removes stale nodes and attributes", () => {
    const host = document.createElement("div")
    patchMarkdown(host, '<p class="old">Draft <em>unfinished</em></p><p>removed</p>')
    patchMarkdown(host, "<h2>Final</h2><p>plain</p>")
    expect(host.innerHTML).toBe("<h2>Final</h2><p>plain</p>")
    patchMarkdown(host, '<h2 title="done">Final</h2>')
    patchMarkdown(host, "<h2>Final</h2>")
    expect(host.innerHTML).toBe("<h2>Final</h2>")
  })
})
