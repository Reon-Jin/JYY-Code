import type { TextPart } from "@jyycode-ai/sdk/v2/client"
import { cleanup, render } from "@solidjs/testing-library"
import { createSignal } from "solid-js"
import { afterEach, describe, expect, it, vi } from "vitest"
import { TextPartView } from "./text-part"

afterEach(() => {
  cleanup()
  vi.useRealTimers()
})

describe("streaming text", () => {
  it("coalesces bursts, retains stable blocks and immediately flushes completion", async () => {
    vi.useFakeTimers()
    const initial: TextPart = {
      id: "prt_1",
      sessionID: "ses_1",
      messageID: "msg_1",
      type: "text",
      text: "First paragraph\n\nTail",
    }
    const [part, setPart] = createSignal(initial)
    const { container } = render(() => <TextPartView part={part()} />)
    const first = container.querySelector("p")!
    for (let i = 0; i < 40; i++) setPart({ ...initial, text: initial.text + ` ${i}` })
    await vi.advanceTimersByTimeAsync(150)
    expect(container.textContent).toContain("Tail 39")
    expect(container.querySelector("p")).toBe(first)
    setPart({ ...initial, text: "Final $x^2$", time: { start: 1, end: 2 } })
    expect(container.textContent).not.toContain("Tail")
    expect(container.querySelector(".katex")).not.toBeNull()
    await vi.advanceTimersByTimeAsync(500)
    expect(container.textContent).not.toContain("Tail")
  })
})
