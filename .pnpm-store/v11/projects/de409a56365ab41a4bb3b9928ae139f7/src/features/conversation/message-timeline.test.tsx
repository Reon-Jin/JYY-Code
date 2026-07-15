import type { Message, Part } from "@jyycode-ai/sdk/v2/client"
import { cleanup, fireEvent, render, screen, waitFor, within } from "@solidjs/testing-library"
import userEvent from "@testing-library/user-event"
import { createSignal } from "solid-js"
import { afterEach, describe, expect, it } from "vitest"
import type { ConversationMessage } from "./conversation-state"
import { MessageTimeline } from "./message-timeline"
import { TaskActivityContent } from "./task-activity"
import { taskSessionID } from "./tool-call-card"

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
  it("hides synthetic prompts and replaces cluster plan JSON with a planning state", () => {
    const clusterInfo: Message = { ...assistantInfo, agent: "cluster", mode: "cluster" }
    render(() => (
      <MessageTimeline
        planStatus="planning"
        messages={[
          conversation(
            [
              { id: "part_real", sessionID, messageID: info.id, type: "text", text: "创建任务" },
              {
                id: "part_internal",
                sessionID,
                messageID: info.id,
                type: "text",
                text: "=== CURRENT TURN SCOPE === internal",
                synthetic: true,
              },
            ],
            info,
          ),
          conversation(
            [
              {
                id: "part_plan",
                sessionID,
                messageID: clusterInfo.id,
                type: "text",
                text: '准备计划\n```json\n{"goal":"Ship","tasks":[]}\n```',
              },
            ],
            clusterInfo,
          ),
        ]}
      />
    ))

    expect(screen.getByText("创建任务")).toBeVisible()
    expect(screen.queryByText(/CURRENT TURN SCOPE/)).not.toBeInTheDocument()
    expect(screen.queryByText(/\"goal\"/)).not.toBeInTheDocument()
    expect(screen.getByRole("status")).toHaveTextContent("正在生成计划")
  })
  it("omits the visible user label and renders distinct user/Agent alignment", () => {
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
    expect(within(userMessage).queryByText("我")).not.toBeInTheDocument()
    expect(userMessage.querySelector("header")).toBeNull()
    expect(within(userMessage).getByText("用户消息")).toBeVisible()
    expect(assistantMessage).toHaveAttribute("data-role", "assistant")
    expect(within(assistantMessage).getByText("build")).toBeVisible()
  })

  it("merges consecutive assistant steps into one response", () => {
    const nextAssistantInfo = { ...assistantInfo, id: "msg_assistant_2", time: { created: 4, completed: 5 } }

    render(() => (
      <MessageTimeline
        messages={[
          conversation([{ id: "part_user", sessionID, messageID: info.id, type: "text", text: "用户消息" }]),
          conversation(
            [{ id: "part_assistant_1", sessionID, messageID: assistantInfo.id, type: "text", text: "第一步" }],
            assistantInfo,
          ),
          conversation(
            [{ id: "part_assistant_2", sessionID, messageID: nextAssistantInfo.id, type: "text", text: "第二步" }],
            nextAssistantInfo,
          ),
        ]}
      />
    ))

    expect(screen.getAllByLabelText("Agent 回复")).toHaveLength(1)
    expect(screen.getAllByText("build")).toHaveLength(1)
    expect(screen.getByText("第一步")).toBeVisible()
    expect(screen.getByText("第二步")).toBeVisible()
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

    const toggle = screen.getByRole("button", { name: /思考与工具调用/ })
    expect(toggle).toHaveAttribute("aria-expanded", "false")
    expect(screen.queryByText("private reasoning")).not.toBeInTheDocument()
    await user.click(toggle)
    expect(toggle).toHaveAttribute("aria-expanded", "true")
    const reasoningToggle = screen.getByRole("button", { name: "思考过程" })
    expect(reasoningToggle).toHaveAttribute("aria-expanded", "false")
    await user.click(reasoningToggle)
    expect(screen.getByText("private reasoning")).toBeVisible()
  })

  it("groups consecutive reasoning and tool calls behind one collapsible control", async () => {
    const user = userEvent.setup()
    render(() => (
      <MessageTimeline
        messages={[
          conversation(
            [
              {
                id: "part_reasoning_grouped",
                sessionID,
                messageID: assistantInfo.id,
                type: "reasoning",
                text: "grouped reasoning",
                time: { start: 1, end: 2 },
              },
              {
                id: "part_tool_grouped",
                sessionID,
                messageID: assistantInfo.id,
                type: "tool",
                callID: "call_grouped",
                tool: "read",
                state: {
                  status: "completed",
                  input: { filePath: "README.md" },
                  output: "contents",
                  title: "Read README.md",
                  metadata: {},
                  time: { start: 2, end: 3 },
                },
              },
              {
                id: "part_text_after_group",
                sessionID,
                messageID: assistantInfo.id,
                type: "text",
                text: "Visible answer",
              },
            ],
            assistantInfo,
          ),
        ]}
      />
    ))

    const toggle = screen.getByRole("button", { name: /思考与工具调用/ })
    expect(toggle).toHaveAttribute("aria-expanded", "false")
    expect(screen.queryByText("Read README.md")).not.toBeInTheDocument()
    expect(screen.getByText("Visible answer")).toBeVisible()

    await user.click(toggle)
    expect(toggle).toHaveAttribute("aria-expanded", "true")
    expect(screen.getByText("Read README.md")).toBeVisible()
    expect(screen.getByText("Visible answer")).toBeVisible()
  })

  it("does not render a bubble for a synthetic-only user message", () => {
    const { container } = render(() => (
      <MessageTimeline
        messages={[
          conversation([
            {
              id: "part_internal_only",
              sessionID,
              messageID: info.id,
              type: "text",
              text: "internal orchestration prompt",
              synthetic: true,
            },
          ]),
        ]}
      />
    ))

    expect(container.querySelector('.conversation-message[data-role="user"]')).toBeNull()
    expect(screen.getByRole("status")).toHaveTextContent("还没有消息")
  })

  it("appends task child activity while keeping it in one process group", async () => {
    const tool = (id: string, title: string): Part => ({
      id,
      sessionID: "ses_child",
      messageID: "msg_child",
      type: "tool",
      callID: `call_${id}`,
      tool: "read",
      state: {
        status: "completed",
        input: {},
        output: "done",
        title,
        metadata: {},
        time: { start: 1, end: 2 },
      },
    })
    const childInfo = { ...assistantInfo, id: "msg_child", sessionID: "ses_child" }
    const [messages, setMessages] = createSignal([conversation([tool("part_child_1", "Read first file")], childInfo)])

    render(() => <TaskActivityContent messages={messages()} running />)

    expect(screen.getByRole("button", { name: /Task 执行过程/ })).toHaveAttribute("aria-expanded", "true")
    expect(screen.getByText("Read first file")).toBeVisible()

    setMessages([conversation([tool("part_child_1", "Read first file"), tool("part_child_2", "Read second file")], childInfo)])
    await waitFor(() => expect(screen.getByText("Read second file")).toBeVisible())
  })

  it("finds the child session attached to a running task tool", () => {
    expect(
      taskSessionID({
        id: "part_task",
        sessionID,
        messageID: assistantInfo.id,
        type: "tool",
        callID: "call_task",
        tool: "task",
        state: {
          status: "running",
          input: { description: "Explore project" },
          title: "Explore project",
          metadata: { sessionId: "ses_child" },
          time: { start: 1 },
        },
      }),
    ).toBe("ses_child")
  })

  it("renders a compact tool summary without a detail panel or raw payload", async () => {
    const user = userEvent.setup()
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

    await user.click(screen.getByRole("button", { name: /思考与工具调用/ }))
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
