import { cleanup, fireEvent, render, screen } from "@solidjs/testing-library"
import { createSignal } from "solid-js"
import { afterEach, describe, expect, it, vi } from "vitest"
import { MarkdownView } from "./markdown-view"
import { TextPartView } from "./text-part"
import { loadMarkdownHighlighting } from "./markdown"
import { openExternalUrl } from "../../platform/external-url"
import type { TextPart } from "@jyycode-ai/sdk/v2/client"

vi.mock("../../platform/external-url", () => ({ openExternalUrl: vi.fn(async () => undefined) }))
afterEach(() => {
  cleanup()
  vi.useRealTimers()
  vi.restoreAllMocks()
})
const image = "![sample](data:image/png;base64,aGVsbG8=)"

describe("rich Markdown interactions", () => {
  it("copies original code and formulas, folds code and opens web links", async () => {
    const writeText = vi.fn(async () => undefined)
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } })
    const source = '```python\nprint("Hello")\n```\n\n$$\nx^2\n$$\n\n[Documentation](https://example.com)'
    const { container } = render(() => <MarkdownView source={source} />)
    fireEvent.click(screen.getByText("复制代码"))
    expect(writeText).toHaveBeenLastCalledWith('print("Hello")')
    fireEvent.click(screen.getByText("复制公式"))
    expect(writeText).toHaveBeenLastCalledWith("x^2")
    fireEvent.click(screen.getByText("收起"))
    expect(container.querySelector(".markdown-code")).toHaveAttribute("data-md-collapsed", "true")
    fireEvent.click(screen.getByText("展开"))
    expect(container.querySelector(".markdown-code")).toHaveAttribute("data-md-collapsed", "false")
    fireEvent.click(screen.getByText("Documentation"))
    expect(openExternalUrl).toHaveBeenCalledWith("https://example.com")
  })

  it("retains math, code, table scroll, image source, selection and preview throughout streaming and completion", async () => {
    await loadMarkdownHighlighting()
    vi.useFakeTimers()
    const prefix =
      "Selected text\n\n$$\n\\sqrt{x^2+1}\n$$\n\n```python\nprint(1)\n```\n\n| A | B |\n|---|---|\n| 1 | 2 |\n\n" +
      image +
      "\n\n"
    const initial: TextPart = { id: "p1", sessionID: "s1", messageID: "m1", type: "text", text: prefix + "Tail" }
    const [part, setPart] = createSignal(initial)
    const { container } = render(() => <TextPartView part={part()} />)
    const math = container.querySelector(".katex")!
    const pre = container.querySelector("pre")!
    const table = container.querySelector("table")!
    const img = container.querySelector("img")!
    pre.scrollLeft = 42
    table.scrollLeft = 23
    fireEvent.click(screen.getByText("收起"))
    fireEvent.click(screen.getByRole("button", { name: "查看图片 sample" }))
    const dialog = screen.getByRole("dialog", { name: "sample" })
    await vi.advanceTimersByTimeAsync(1)
    const range = document.createRange()
    range.setStart(container.querySelector("p")!.firstChild!, 0)
    range.setEnd(container.querySelector("p")!.firstChild!, 13)
    window.getSelection()!.removeAllRanges()
    window.getSelection()!.addRange(range)
    expect(window.getSelection()?.toString()).toBe("Selected text")
    for (let i = 0; i < 20; i++) {
      setPart({ ...initial, text: prefix + "Tail " + i })
      await vi.advanceTimersByTimeAsync(40)
      expect(container.querySelector(".katex")).toBe(math)
      expect(container.querySelector("pre")).toBe(pre)
      expect(container.querySelector("table")).toBe(table)
      expect(container.querySelector("img")).toBe(img)
      expect(screen.getByRole("dialog", { name: "sample" })).toBe(dialog)
    }
    setPart({ ...part(), time: { start: 1, end: 2 } })
    expect(container.querySelector(".katex")).toBe(math)
    expect(pre.scrollLeft).toBe(42)
    expect(table.scrollLeft).toBe(23)
    expect(screen.getByText("展开")).toHaveAttribute("aria-expanded", "false")
    expect(window.getSelection()?.toString()).toBe("Selected text")
    expect(img.getAttribute("src")).toBe("data:image/png;base64,aGVsbG8=")
    window.getSelection()?.removeAllRanges()
  })

  it("keeps image failure state while its paragraph streams and supports keyboard preview", () => {
    const [source, setSource] = createSignal(image + " first")
    const { container } = render(() => <MarkdownView source={source()} mode="streaming" />)
    const img = container.querySelector("img")!
    fireEvent.keyDown(img, { key: "Enter" })
    expect(screen.getByRole("dialog", { name: "sample" })).toBeInTheDocument()
    fireEvent.click(screen.getByRole("button", { name: "关闭" }))
    fireEvent.error(img)
    setSource(image + " more text")
    expect(container.querySelector("img")).toBe(img)
    expect(img).toHaveAttribute("data-md-image-state", "failed")
    expect(img.alt).toBe("图片暂时无法加载")
  })

  it("scopes footnote targets to each message and updates definitions that arrive later", () => {
    const [source, setSource] = createSignal("Text[^a]")
    const { container } = render(() => (
      <>
        <MarkdownView source={source()} />
        <MarkdownView source={"Other[^a]\n\n[^a]: Second note."} />
      </>
    ))
    setSource("Text[^a]\n\n[^a]: First note.")
    const targets = [...container.querySelectorAll(".footnotes li")].map((element) => element.id)
    expect(targets).toHaveLength(2)
    expect(new Set(targets).size).toBe(2)
    const links = [...container.querySelectorAll("sup a")].map((link) => link.getAttribute("href"))
    expect(links).toEqual(targets.map((id) => "#" + id))
  })
})
