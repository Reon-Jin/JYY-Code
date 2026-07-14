import type { Agent, SessionStatus } from "@jyycode-ai/sdk/v2/client"
import { cleanup, fireEvent, render, screen, waitFor } from "@solidjs/testing-library"
import userEvent from "@testing-library/user-event"
import { createSignal, type JSX } from "solid-js"
import { createDesktopQueryClient } from "../../data/query-client"
import { afterEach, describe, expect, it, vi } from "vitest"
import { Composer } from "./composer"
import { createComposerQueueStore } from "./composer-queue"
import type { CatalogModel } from "./model-catalog"

const directory = "C:\\work\\demo"
const sessionID = "ses_1"
const agents: Agent[] = [{ name: "build", mode: "primary", permission: [], options: {} }]
const models: CatalogModel[] = [{ providerID: "openai", providerName: "OpenAI", modelID: "gpt-5", modelName: "GPT-5" }]

function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

function renderComposer(input?: {
  status?: SessionStatus
  lastMessageError?: { name: string }
  disabled?: boolean
  branchControl?: JSX.Element
  multiAgentControl?: JSX.Element
  identityLocked?: boolean
  selectedAgent?: string
  selectedModel?: { providerID: string; modelID: string }
  agents?: Agent[]
  models?: CatalogModel[]
}) {
  const client = {
    session: {
      promptAsync: vi.fn(async (_parameters: unknown, _options?: unknown) => ({ data: undefined })),
      abort: vi.fn(async (_parameters: unknown, _options?: unknown) => ({ data: true })),
    },
  }
  const [status, setStatus] = createSignal<SessionStatus>(input?.status ?? { type: "idle" })
  render(() => (
    <Composer
      client={client as never}
      queryClient={createDesktopQueryClient()}
      directory={directory}
      sessionID={sessionID}
      agents={input?.agents ?? agents}
      models={input?.models ?? models}
      selectedAgent={input?.selectedAgent ?? "build"}
      selectedModel={input?.selectedModel ?? { providerID: "openai", modelID: "gpt-5" }}
      status={status()}
      lastMessageError={input?.lastMessageError}
      disabled={input?.disabled}
      branchControl={input?.branchControl}
      multiAgentControl={input?.multiAgentControl}
      identityLocked={input?.identityLocked}
      agentClusterEnabled
      onAgentChange={vi.fn()}
      onModelChange={vi.fn()}
      onProviderConnected={vi.fn()}
      queueStore={createComposerQueueStore()}
    />
  ))
  return Object.assign(client, { setStatus })
}

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

describe("Composer", () => {
  it("starts on one line and keeps the send control icon-only", () => {
    renderComposer()

    expect(screen.getByRole("textbox", { name: "消息" })).toHaveAttribute("rows", "1")
    expect(screen.getByRole("button", { name: "发送" })).not.toHaveTextContent("发送")
  })

  it("grows with the draft, then scrolls after five lines", () => {
    renderComposer()
    const textbox = screen.getByRole("textbox", { name: "消息" }) as HTMLTextAreaElement
    let scrollHeight = 56
    Object.defineProperty(textbox, "scrollHeight", { configurable: true, get: () => scrollHeight })
    vi.spyOn(window, "getComputedStyle").mockReturnValue({
      lineHeight: "20px",
      paddingTop: "8px",
      paddingBottom: "8px",
      borderTopWidth: "0px",
      borderBottomWidth: "0px",
    } as CSSStyleDeclaration)

    fireEvent.input(textbox, { target: { value: "first\nsecond" } })
    expect(textbox.style.height).toBe("56px")
    expect(textbox.style.overflowY).toBe("hidden")

    scrollHeight = 180
    fireEvent.input(textbox, { target: { value: "1\n2\n3\n4\n5\n6" } })
    expect(textbox.style.height).toBe("116px")
    expect(textbox.style.overflowY).toBe("auto")
    fireEvent.input(textbox, { target: { value: "" } })
  })

  it("exposes labeled selectors and sends on Enter but not Shift+Enter", async () => {
    const user = userEvent.setup()
    const client = renderComposer()
    expect(screen.getByLabelText("Agent")).toBeVisible()
    expect(screen.getByRole("button", { name: "配置模型：OpenAI · GPT-5" })).toBeVisible()
    const textbox = screen.getByRole("textbox", { name: "消息" })

    await user.type(textbox, "line one{shift>}{enter}{/shift}line two")
    expect(client.session.promptAsync).not.toHaveBeenCalled()
    expect(textbox).toHaveValue("line one\nline two")

    await user.keyboard("{Enter}")
    await waitFor(() => expect(client.session.promptAsync).toHaveBeenCalledTimes(1))
  })

  it("renders the Multi-Agent control immediately after Branch in the selector row", () => {
    renderComposer({
      branchControl: <button aria-label="Branch">main</button>,
      multiAgentControl: <button aria-label="Multi-Agent control">Multi-Agent</button>,
    })
    const selectors = screen.getByLabelText("Agent").parentElement?.parentElement
    expect(selectors?.children).toHaveLength(5)
    expect(selectors?.children[0]).toContainElement(screen.getByLabelText("Agent"))
    expect(selectors?.children[1]).toContainElement(screen.getByRole("button", { name: "Connect" }))
    expect(selectors?.children[2]).toContainElement(screen.getByRole("button", { name: /配置模型/ }))
    expect(selectors?.children[3]).toContainElement(screen.getByRole("button", { name: "Branch" }))
    expect(selectors?.children[4]).toContainElement(screen.getByRole("button", { name: "Multi-Agent control" }))
  })

  it("locks child Agent and model identity while keeping messaging enabled", async () => {
    const user = userEvent.setup()
    renderComposer({
      identityLocked: true,
      selectedAgent: "coder",
      selectedModel: { providerID: "test", modelID: "coder-model" },
      agents: [{ name: "coder", mode: "subagent", permission: [], options: {} }],
      models: [],
    })

    expect(screen.getByLabelText("Agent")).toHaveValue("coder")
    expect(screen.getByLabelText("Agent")).toBeDisabled()
    expect(screen.getByRole("button", { name: "当前模型：test/coder-model" })).toBeDisabled()
    const textbox = screen.getByRole("textbox", { name: "消息" })
    expect(textbox).toBeEnabled()
    await user.type(textbox, "guide child")
    expect(screen.getByRole("button", { name: "发送" })).toBeEnabled()
  })

  it("does not submit during IME composition", () => {
    const client = renderComposer()
    const textbox = screen.getByRole("textbox", { name: "消息" })
    fireEvent.input(textbox, { target: { value: "你好" } })
    fireEvent.compositionStart(textbox)
    fireEvent.keyDown(textbox, { key: "Enter", code: "Enter", isComposing: true })
    fireEvent.compositionEnd(textbox)
    expect(client.session.promptAsync).not.toHaveBeenCalled()
  })

  it("locks duplicate Enter, shows busy state, and announces generation politely", async () => {
    const pending = deferred()
    const client = renderComposer()
    client.session.promptAsync.mockImplementationOnce(() => pending.promise.then(() => ({ data: undefined })))
    const textbox = screen.getByRole("textbox", { name: "消息" })
    fireEvent.input(textbox, { target: { value: "hello" } })

    fireEvent.keyDown(textbox, { key: "Enter", code: "Enter" })
    fireEvent.keyDown(textbox, { key: "Enter", code: "Enter" })

    await waitFor(() => expect(client.session.promptAsync).toHaveBeenCalledTimes(1))
    expect(screen.getByRole("button", { name: "正在发送" })).toHaveAttribute("aria-busy", "true")
    expect(screen.getByRole("status")).toHaveAttribute("aria-live", "polite")
    expect(screen.getByRole("status")).toHaveTextContent("正在发送消息")
    pending.resolve()
    await waitFor(() => expect(screen.getByRole("button", { name: "发送" })).not.toHaveAttribute("aria-busy"))
    expect(textbox).toHaveValue("")
  })

  it("replaces Send with Stop while the session is active", async () => {
    const user = userEvent.setup()
    const client = renderComposer({ status: { type: "busy" } })
    expect(screen.queryByRole("button", { name: "发送" })).not.toBeInTheDocument()
    await user.click(screen.getByRole("button", { name: "停止" }))
    expect(client.session.abort).toHaveBeenCalledWith({ directory, sessionID }, { throwOnError: true })
    expect(screen.getByRole("status")).toHaveTextContent(/正在生成|正在停止/)
  })

  it("queues prompts while busy and drains one per busy-to-idle cycle", async () => {
    const user = userEvent.setup()
    const client = renderComposer({ status: { type: "busy" } })
    const textbox = screen.getByRole("textbox", { name: "消息" })

    await user.type(textbox, "first queued{Enter}")
    await user.type(textbox, "second queued")
    await user.click(screen.getByRole("button", { name: "加入队列" }))

    expect(client.session.promptAsync).not.toHaveBeenCalled()
    expect(screen.getByText("排队等待 · 2")).toBeVisible()
    expect(screen.getByText("first queued")).toBeVisible()
    expect(screen.getByText("second queued")).toBeVisible()

    client.setStatus({ type: "idle" })
    await waitFor(() => expect(client.session.promptAsync).toHaveBeenCalledTimes(1))
    expect((client.session.promptAsync.mock.calls[0]?.[0] as { parts: unknown }).parts).toEqual([
      { type: "text", text: "first queued" },
    ])
    expect(screen.getByText("second queued")).toBeVisible()

    client.setStatus({ type: "busy" })
    await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("Agent 正在生成回复"))
    client.setStatus({ type: "idle" })
    await waitFor(() => expect(client.session.promptAsync).toHaveBeenCalledTimes(2))
    expect((client.session.promptAsync.mock.calls[1]?.[0] as { parts: unknown }).parts).toEqual([
      { type: "text", text: "second queued" },
    ])
  })

  it("removes a pending queued prompt", async () => {
    const user = userEvent.setup()
    renderComposer({ status: { type: "busy" } })
    const textbox = screen.getByRole("textbox", { name: "消息" })
    await user.type(textbox, "remove me{Enter}")

    await user.click(screen.getByRole("button", { name: "移除排队消息 1" }))
    expect(screen.queryByText("remove me")).not.toBeInTheDocument()
    expect(screen.queryByLabelText("排队等待的消息")).not.toBeInTheDocument()
  })

  it("keeps a failed draft and offers Retry", async () => {
    const user = userEvent.setup()
    const client = renderComposer()
    client.session.promptAsync.mockRejectedValueOnce(new Error("offline"))
    const textbox = screen.getByRole("textbox", { name: "消息" })
    await user.type(textbox, "keep me")
    await user.keyboard("{Enter}")

    expect(await screen.findByRole("alert")).toHaveTextContent("offline")
    expect(textbox).toHaveValue("keep me")
    await user.click(screen.getByRole("button", { name: "重试" }))
    await waitFor(() => expect(client.session.promptAsync).toHaveBeenCalledTimes(2))
  })

  it("announces an aborted response as information instead of an error", () => {
    renderComposer({ lastMessageError: { name: "MessageAbortedError" } })
    expect(screen.getByRole("status")).toHaveTextContent("已停止生成")
    expect(screen.queryByRole("alert")).not.toBeInTheDocument()
  })

  it("keeps the draft editable but prevents a new Prompt while disconnected", async () => {
    const user = userEvent.setup()
    const client = renderComposer({ disabled: true })
    const textbox = screen.getByRole("textbox", { name: "消息" })

    await user.type(textbox, "wait for reconnect")
    await user.keyboard("{Enter}")

    expect(textbox).toHaveValue("wait for reconnect")
    expect(client.session.promptAsync).not.toHaveBeenCalled()
    expect(screen.getByRole("button", { name: "发送" })).toBeDisabled()
    expect(screen.getByRole("status")).toHaveTextContent("消息已暂存")
  })
})
