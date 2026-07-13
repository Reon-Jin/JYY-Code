import type { Message, Part } from "@jyycode-ai/sdk/v2/client"
import { cleanup, fireEvent, render, screen, waitFor, within } from "@solidjs/testing-library"
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

const assistantInfo: Message = {
  id: "msg_assistant",
  sessionID,
  role: "assistant",
  time: { created: 2, completed: 3 },
  parentID: info.id,
  modelID: "gpt-5",
  providerID: "openai",
  mode: "build",
  agent: "build",
  path: { cwd: "D:\\cpp", root: "D:\\cpp" },
  cost: 0,
  tokens: { input: 1, output: 1, reasoning: 0, cache: { read: 0, write: 0 } },
  finish: "stop",
}

function conversation(parts: Part[], message = info): ConversationMessage {
  return { info: message, parts }
}

afterEach(cleanup)

describe("MessageTimeline", () => {
  it("labels the user as me and renders distinct user/Agent alignment", () => {
    render(() => (
      <MessageTimeline
        messages={[
          conversation([{ id: "part_user", sessionID, messageID: info.id, type: "text", text: "用户消息" }]),
          conversation(
            [{ id: "part_assistant", sessionID, messageID: assistantInfo.id, type: "text", text: "AI 回复" }],
            assistantInfo,
          ),
        ]}
      />
    ))

    const userMessage = screen.getByLabelText("我的消息")
    const assistantMessage = screen.getByLabelText("Agent 回复")
    expect(userMessage).toHaveAttribute("data-role", "user")
    expect(within(userMessage).getByText("我")).toBeVisible()
    expect(assistantMessage).toHaveAttribute("data-role", "assistant")
    expect(within(assistantMessage).getByText("build")).toBeVisible()
  })

  it("renders text updates as streaming deltas arrive", async () => {
    const initial = conversation([{ id: "part_stream", sessionID, messageID: info.id, type: "text", text: "Hel" }])
    const [messages, setMessages] = createSignal([initial])
    render(() => <MessageTimeline messages={messages()} />)

    expect(screen.getByText("Hel")).toBeVisible()
    setMessages([
      conversation([{ id: "part_stream", sessionID, messageID: info.id, type: "text", text: "Hello" }]),
    ])
    await waitFor(() => expect(screen.getByText("Hello")).toBeVisible())
    expect(screen.queryByText("Hel")).not.toBeInTheDocument()
  })

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

  it("renders a compact tool summary without a detail panel or raw payload", () => {
    const { container } = render(() => (
      <MessageTimeline
        messages={[
          conversation(
            [
              {
                id: "part_tool",
                sessionID,
                messageID: assistantInfo.id,
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
            ],
            assistantInfo,
          ),
        ]}
      />
    ))

    expect(screen.getByText("Run command")).toBeVisible()
    expect(screen.getByText("shell")).toBeVisible()
    expect(screen.getByText("已完成 · 11ms")).toBeVisible()
    expect(screen.queryByText("查看工具详情")).not.toBeInTheDocument()
    expect(screen.queryByText(/<img src=x onerror=alert/)).not.toBeInTheDocument()
    expect(container.querySelector("details")).toBeNull()
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
