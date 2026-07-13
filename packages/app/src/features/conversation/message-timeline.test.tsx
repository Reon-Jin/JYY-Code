import type { Message, Part } from "@jyycode-ai/sdk/v2/client"
import { cleanup, fireEvent, render, screen, waitFor } from "@solidjs/testing-library"
import userEvent from "@testing-library/user-event"
import { createSignal } from "solid-js"
import { afterEach, describe, expect, it } from "vitest"
import type { ConversationMessage } from "./conversation-state"
import { MessageTimeline } from "./message-timeline"

const sessionID = "ses_1"
const info: Message = {
  id: "msg_1",
  sessionID,
  role: "user",
  time: { created: 1 },
  agent: "build",
  model: { providerID: "openai", modelID: "gpt-5" },
}

function conversation(parts: Part[], message = info): ConversationMessage {
  return { info: message, parts }
}

afterEach(cleanup)

describe("MessageTimeline", () => {
  it("keeps reasoning collapsed until explicitly expanded", async () => {
    const user = userEvent.setup()
    render(() => (
      <MessageTimeline
        messages={[
          conversation([
            {
              id: "part_reasoning",
              sessionID,
              messageID: info.id,
              type: "reasoning",
              text: "private reasoning",
              time: { start: 1 },
            },
          ]),
        ]}
      />
    ))

    const toggle = screen.getByRole("button", { name: "思考过程" })
    expect(toggle).toHaveAttribute("aria-expanded", "false")
    expect(screen.queryByText("private reasoning")).not.toBeInTheDocument()
    await user.click(toggle)
    expect(toggle).toHaveAttribute("aria-expanded", "true")
    expect(screen.getByText("private reasoning")).toBeVisible()
  })

  it("renders tool output as text instead of raw HTML", async () => {
    const user = userEvent.setup()
    const { container } = render(() => (
      <MessageTimeline
        messages={[
          conversation([
            {
              id: "part_tool",
              sessionID,
              messageID: info.id,
              type: "tool",
              callID: "call_1",
              tool: "shell",
              state: {
                status: "completed",
                input: { command: "echo" },
                output: "<img src=x onerror=alert(1)>",
                title: "Run command",
                metadata: {},
                time: { start: 1, end: 12 },
              },
            },
          ]),
        ]}
      />
    ))

    await user.click(screen.getByText("查看工具详情"))
    expect(screen.getByText(/<img src=x onerror=alert/)).toBeVisible()
    expect(container.querySelector(".tool-call__details img")).toBeNull()
  })

  it("does not steal scroll and offers a new-message jump", async () => {
    const user = userEvent.setup()
    const initial = conversation([{ id: "part_1", sessionID, messageID: info.id, type: "text", text: "first" }])
    const secondInfo = { ...info, id: "msg_2", time: { created: 2 } }
    const second = conversation(
      [{ id: "part_2", sessionID, messageID: secondInfo.id, type: "text", text: "second" }],
      secondInfo,
    )
    const [messages, setMessages] = createSignal([initial])
    const { container } = render(() => <MessageTimeline messages={messages()} />)
    const viewport = container.querySelector<HTMLDivElement>(".message-timeline__viewport")!
    Object.defineProperties(viewport, {
      clientHeight: { configurable: true, value: 200 },
      scrollHeight: { configurable: true, value: 1_000 },
    })
    await Promise.resolve()
    viewport.scrollTop = 0
    fireEvent.scroll(viewport)

    setMessages([initial, second])

    const jump = await screen.findByRole("button", { name: "新消息" })
    expect(viewport.scrollTop).toBe(0)
    await user.click(jump)
    await waitFor(() => expect(viewport.scrollTop).toBe(1_000))
  })
})
