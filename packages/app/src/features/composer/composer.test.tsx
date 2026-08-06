import type { Agent, SessionStatus } from "@jyycode-ai/sdk/v2/client"
import { cleanup, fireEvent, render, screen, waitFor, within } from "@solidjs/testing-library"
import userEvent from "@testing-library/user-event"
import { createSignal, type JSX } from "solid-js"
import { createDesktopQueryClient } from "../../data/query-client"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { attachmentFromPath, Composer, type ComposerProps } from "./composer"
import { createComposerQueueStore } from "./composer-queue"
import type { CatalogModel, ModelSelection } from "./model-catalog"

let desktopDropHandler: ((event: { payload: unknown }) => void) | undefined
vi.mock("@tauri-apps/api/webview", () => ({
  getCurrentWebview: () => ({
    onDragDropEvent: vi.fn(async (handler: (event: { payload: unknown }) => void) => {
      desktopDropHandler = handler
      return vi.fn()
    }),
  }),
}))

const directory = "C:\\work\\demo"
const sessionID = "ses_1"
const agents: Agent[] = [{ name: "build", mode: "primary", permission: [], options: {} }]
const models: CatalogModel[] = [
  {
    providerID: "openai",
    providerName: "OpenAI",
    modelID: "gpt-5",
    modelName: "GPT-5",
    contextWindow: 128_000,
    variants: ["low", "high"],
  },
  {
    providerID: "openai",
    providerName: "OpenAI",
    modelID: "gpt-4.1",
    modelName: "GPT-4.1",
    contextWindow: 128_000,
    variants: [],
  },
]

function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

function renderComposer(input?: {
  status?: SessionStatus
  requestPending?: boolean
  childSteering?: boolean
  disabled?: boolean
  branchControl?: JSX.Element
  multiAgentControl?: JSX.Element
  goalModeControl?: JSX.Element
  mcpControl?: JSX.Element
  permissionControl?: JSX.Element
  identityLocked?: boolean
  minimal?: boolean
  selectedAgent?: string
  selectedModel?: ModelSelection
  agents?: Agent[]
  models?: CatalogModel[]
  usage?: ComposerProps["usage"]
  skills?: Array<{ name: string; description?: string; location: string; content: string }>
}) {
  const client = {
    app: {
      skills: vi.fn(async () => ({
        data: input?.skills ?? [
          { name: "documents", description: "Create and edit documents", location: "skills/documents", content: "" },
          { name: "pdf", description: "Create and inspect PDFs", location: "skills/pdf", content: "" },
        ],
      })),
    },
    session: {
      promptAsync: vi.fn(async (_parameters: unknown, _options?: unknown) => ({ data: undefined })),
      command: vi.fn(async (_parameters: unknown, _options?: unknown) => ({ data: undefined })),
      abort: vi.fn(async (_parameters: unknown, _options?: unknown) => ({ data: true })),
      interruptPrompt: vi.fn(async (_parameters: unknown, _options?: unknown) => ({ data: undefined })),
      terminate: vi.fn(async (_parameters: unknown, _options?: unknown) => ({ data: undefined })),
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
      requestPending={input?.requestPending}
      childSteering={input?.childSteering}
      disabled={input?.disabled}
      branchControl={input?.branchControl}
      multiAgentControl={input?.multiAgentControl}
      goalModeControl={input?.goalModeControl}
      mcpControl={input?.mcpControl}
      permissionControl={input?.permissionControl}
      identityLocked={input?.identityLocked}
      minimal={input?.minimal}
      usage={input?.usage}
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
  desktopDropHandler = undefined
  delete (window as Window & { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__
})

beforeEach(() => {
  Object.defineProperties(HTMLDialogElement.prototype, {
    close: {
      configurable: true,
      value(this: HTMLDialogElement) {
        this.removeAttribute("open")
        this.dispatchEvent(new Event("close"))
      },
    },
    showModal: {
      configurable: true,
      value(this: HTMLDialogElement) {
        this.setAttribute("open", "")
      },
    },
  })
})

describe("Composer", () => {
  it("keeps a child steering action visible while its assignment is running", async () => {
    const user = userEvent.setup()
    const client = renderComposer({ minimal: true, childSteering: true, status: { type: "busy" } })

    await user.type(screen.getByRole("textbox", { name: "消息" }), "stop and explain")
    await user.click(screen.getByRole("button", { name: "发送并中断" }))

    await waitFor(() => expect(client.session.interruptPrompt).toHaveBeenCalledOnce())
    expect(client.session.promptAsync).not.toHaveBeenCalled()
    expect(screen.getByText("发送此消息会中断当前任务。")).toBeVisible()
  })

  it("terminates a child assignment only after confirming", async () => {
    const user = userEvent.setup()
    const client = renderComposer({ minimal: true, childSteering: true, status: { type: "busy" } })

    await user.click(screen.getByRole("button", { name: "终止" }))
    expect(client.session.terminate).not.toHaveBeenCalled()

    await user.click(screen.getByRole("button", { name: "确认终止？" }))
    await waitFor(() => expect(client.session.terminate).toHaveBeenCalledOnce())
    expect(client.session.terminate).toHaveBeenCalledWith({ directory, sessionID }, { throwOnError: true })
  })

  it("lets a minimal child composer send while the child session is idle", async () => {
    const user = userEvent.setup()
    const client = renderComposer({ minimal: true, childSteering: false, status: { type: "idle" } })

    await user.type(screen.getByRole("textbox", { name: "消息" }), "follow up")
    await user.click(screen.getByRole("button", { name: "发送" }))

    await waitFor(() => expect(client.session.promptAsync).toHaveBeenCalledOnce())
    expect(client.session.interruptPrompt).not.toHaveBeenCalled()
  })

  it("converts native desktop file paths into prompt attachments", () => {
    expect(attachmentFromPath("C:\\Users\\dev\\My report.pdf")).toEqual({
      type: "file",
      mime: "application/pdf",
      filename: "My report.pdf",
      url: "file:///C:/Users/dev/My%20report.pdf",
    })
    expect(attachmentFromPath("/tmp/archive.bin")).toMatchObject({
      mime: "application/octet-stream",
      filename: "archive.bin",
      url: "file:///tmp/archive.bin",
    })
  })

  it("accepts a native Tauri file drop inside the input region", async () => {
    Object.defineProperty(window, "__TAURI_INTERNALS__", { configurable: true, value: {} })
    renderComposer()
    const input = screen.getByRole("textbox", { name: "消息" }).parentElement!
    vi.spyOn(input, "getBoundingClientRect").mockReturnValue({
      x: 10,
      y: 20,
      top: 20,
      right: 410,
      bottom: 100,
      left: 10,
      width: 400,
      height: 80,
      toJSON: () => ({}),
    })
    await waitFor(() => expect(desktopDropHandler).toBeDefined())

    desktopDropHandler!({
      payload: { type: "drop", paths: ["C:\\work\\design.png"], position: { x: 80, y: 60 } },
    })

    await waitFor(() => expect(screen.getByRole("list", { name: "附件" })).toHaveTextContent("design.png"))
    expect(input).toHaveAttribute("data-dragging", "false")
    expect(screen.getByRole("textbox", { name: "消息" })).not.toHaveFocus()
  })

  it("starts on one line and keeps the send control icon-only", () => {
    renderComposer()

    expect(screen.getByRole("textbox", { name: "消息" })).toHaveAttribute("rows", "1")
    expect(screen.getByRole("button", { name: "发送" })).not.toHaveTextContent("发送")
  })

  it("adds files from the attachment picker and sends them with the message", async () => {
    const user = userEvent.setup()
    const client = renderComposer()
    const file = new File(["hello attachment"], "notes.txt", { type: "text/plain" })

    await user.upload(screen.getByLabelText("选择文件"), file)
    await waitFor(() => expect(screen.getByRole("list", { name: "附件" })).toHaveTextContent("notes.txt"))

    await user.type(screen.getByRole("textbox", { name: "消息" }), "read this")
    await user.click(screen.getByRole("button", { name: "发送" }))

    await waitFor(() => expect(client.session.promptAsync).toHaveBeenCalledOnce())
    expect((client.session.promptAsync.mock.calls[0]![0] as { parts: unknown }).parts).toEqual([
      { type: "text", text: "read this" },
      expect.objectContaining({
        type: "file",
        mime: "text/plain",
        filename: "notes.txt",
        url: expect.stringMatching(/^data:text\/plain;base64,/),
      }),
    ])
    expect(screen.queryByRole("list", { name: "附件" })).not.toBeInTheDocument()
  })

  it("accepts dropped files and can send an attachment without text", async () => {
    const user = userEvent.setup()
    const client = renderComposer()
    const input = screen.getByRole("textbox", { name: "消息" }).parentElement!
    const file = new File([new Uint8Array([1, 2, 3])], "archive.bin")

    fireEvent.drop(input, {
      dataTransfer: { files: [file], types: ["Files"], dropEffect: "none" },
    })
    await waitFor(() => expect(screen.getByRole("list", { name: "附件" })).toHaveTextContent("archive.bin"))
    expect(screen.getByRole("button", { name: "发送" })).toBeEnabled()

    await user.click(screen.getByRole("button", { name: "发送" }))
    await waitFor(() => expect(client.session.promptAsync).toHaveBeenCalledOnce())
    expect((client.session.promptAsync.mock.calls[0]![0] as { parts: unknown }).parts).toEqual([
      expect.objectContaining({ type: "file", mime: "application/octet-stream", filename: "archive.bin" }),
    ])
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
    expect(screen.getByLabelText("智能体")).toBeVisible()
    await user.click(screen.getByRole("button", { name: "配置模型" }))
    expect(screen.getByRole("dialog", { name: "模型设置" })).toBeVisible()
    expect(screen.getByRole("combobox", { name: "模型" })).toHaveValue("openai/gpt-5")
    expect(screen.getByRole("combobox", { name: "思考深度" })).toHaveValue("")
    expect(screen.queryByRole("combobox", { name: "子 Agent 模型" })).not.toBeInTheDocument()
    expect(screen.queryByRole("combobox", { name: "子 Agent 思考深度" })).not.toBeInTheDocument()
    await user.selectOptions(screen.getByRole("combobox", { name: "思考深度" }), "low")
    expect(screen.getByRole("combobox", { name: "思考深度" })).toHaveValue("low")
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
      mcpControl: <button aria-label="MCP control">MCP</button>,
    })
    const selectors = screen.getByLabelText("智能体").parentElement?.parentElement
    expect(selectors?.children).toHaveLength(6)
    expect(selectors?.children[0]).toContainElement(screen.getByLabelText("智能体"))
    expect(selectors?.children[1]).toContainElement(screen.getByRole("button", { name: "连接" }))
    expect(selectors?.children[2]).toContainElement(screen.getByRole("button", { name: "配置模型" }))
    expect(selectors?.children[3]).toContainElement(screen.getByRole("button", { name: "Branch" }))
    expect(selectors?.children[4]).toContainElement(screen.getByRole("button", { name: "Multi-Agent control" }))
    expect(selectors?.children[5]).toContainElement(screen.getByRole("button", { name: "MCP control" }))
  })

  it("keeps child model controls out of the Composer", async () => {
    renderComposer()

    await userEvent.setup().click(screen.getByRole("button", { name: "配置模型" }))
    expect(screen.queryByText("子 Agent")).not.toBeInTheDocument()
    expect(screen.queryByRole("combobox", { name: "子 Agent 模型" })).not.toBeInTheDocument()
    expect(screen.queryByRole("combobox", { name: "子 Agent 思考深度" })).not.toBeInTheDocument()
  })

  it("opens Skill suggestions for a slash query and selects them without submitting", async () => {
    const user = userEvent.setup()
    const client = renderComposer()
    const textbox = screen.getByRole("textbox", { name: "消息" })

    await user.type(textbox, "/")
    const listbox = await screen.findByRole("listbox", { name: "Skills" })
    expect(within(listbox).getByRole("option", { name: /documents/ })).toBeVisible()
    expect(within(listbox).getByRole("option", { name: /pdf/ })).toBeVisible()

    await user.keyboard("{ArrowDown}{Enter}")

    expect(textbox).toHaveValue("/pdf ")
    expect(client.session.promptAsync).not.toHaveBeenCalled()
    expect(client.session.command).not.toHaveBeenCalled()
    expect(screen.queryByRole("listbox", { name: "Skills" })).not.toBeInTheDocument()
    fireEvent.input(textbox, { target: { value: "" } })
  })

  it("filters Skill suggestions and dismisses them with Escape", async () => {
    const user = userEvent.setup()
    renderComposer()
    const textbox = screen.getByRole("textbox", { name: "消息" })

    await user.type(textbox, "/doc")
    const listbox = await screen.findByRole("listbox", { name: "Skills" })
    expect(within(listbox).getByRole("option", { name: /documents/ })).toBeVisible()
    expect(within(listbox).queryByRole("option", { name: /pdf/ })).not.toBeInTheDocument()

    await user.keyboard("{Escape}")
    expect(textbox).toHaveValue("/doc")
    expect(screen.queryByRole("listbox", { name: "Skills" })).not.toBeInTheDocument()
    fireEvent.input(textbox, { target: { value: "" } })
  })

  it("locks child Agent and model identity while keeping messaging enabled", async () => {
    const user = userEvent.setup()
    renderComposer({
      identityLocked: true,
      selectedAgent: "worker",
      selectedModel: { providerID: "test", modelID: "worker-model" },
      agents: [{ name: "worker", mode: "subagent", permission: [], options: {} }],
      models: [],
    })

    expect(screen.getByLabelText("智能体")).toHaveValue("worker")
    expect(screen.getByLabelText("智能体")).toBeDisabled()
    expect(screen.getByRole("button", { name: "配置模型" })).toBeDisabled()
    const textbox = screen.getByRole("textbox", { name: "消息" })
    expect(textbox).toBeEnabled()
    await user.type(textbox, "guide child")
    expect(screen.getByRole("button", { name: "发送" })).toBeEnabled()
  })

  it("keeps next-turn Agent, provider, and model controls available while a turn is running", () => {
    renderComposer({ status: { type: "busy" } })

    expect(screen.getByLabelText("智能体")).toBeEnabled()
    expect(screen.getByRole("button", { name: "连接" })).toBeEnabled()
    expect(screen.getByRole("button", { name: "配置模型" })).toBeEnabled()
  })

  it("renders child Sessions as a message-only Composer that still sends with Enter", async () => {
    const user = userEvent.setup()
    const client = renderComposer({
      identityLocked: true,
      minimal: true,
      branchControl: <button aria-label="Branch">main</button>,
      multiAgentControl: <button aria-label="Multi-Agent control">Multi-Agent</button>,
    })

    expect(screen.getByRole("textbox", { name: "消息" })).toBeVisible()
    expect(screen.queryByLabelText("智能体")).not.toBeInTheDocument()
    // The only control is the icon-only send button; selectors stay hidden.
    expect(screen.getByRole("button", { name: "发送" })).toBeVisible()
    await user.type(screen.getByRole("textbox", { name: "消息" }), "review this{enter}")
    await waitFor(() => expect(client.session.promptAsync).toHaveBeenCalledOnce())
  })

  it("uses the area below the input for root context, aggregate tokens, cost, and an exact breakdown", () => {
    renderComposer({
      permissionControl: <span>权限 自动模式</span>,
      usage: {
        contextWindow: 128_000,
        contextUsed: 32_000,
        contextPercent: 25,
        aggregate: {
          tokens: { input: 10_000, output: 2_000, reasoning: 1_000, other: 500, subagents: 6_500, total: 20_000 },
          cost: 1.2345,
        },
      },
    })

    expect(screen.getByLabelText("会话用量")).toHaveTextContent("权限 自动模式")
    expect(screen.getByLabelText("会话用量")).not.toHaveTextContent("上下文窗口")
    expect(screen.getByLabelText("会话用量")).toHaveTextContent("25.0%")
    expect(screen.getByLabelText("会话用量")).toHaveTextContent("主 + 子智能体 Token")
    expect(screen.getByRole("tooltip")).toHaveTextContent("输入10,000")
    expect(screen.getByRole("tooltip")).toHaveTextContent("工具调用已计入输入/输出，提供商未单列")
    expect(screen.getByLabelText("会话用量")).toHaveTextContent("¥8.8884")
  })

  it("shows only context metrics in a child composer", () => {
    renderComposer({
      minimal: true,
      permissionControl: <span>权限 自动模式</span>,
      usage: { contextWindow: 64_000, contextUsed: 16_000, contextPercent: 25 },
    })

    expect(screen.getByLabelText("会话用量")).toHaveTextContent("权限 自动模式")
    expect(screen.getByLabelText("会话用量")).not.toHaveTextContent("上下文窗口")
    expect(screen.getByLabelText("会话用量")).toHaveTextContent("窗口使用情况")
    expect(screen.queryByText("主 + 子智能体 Token")).not.toBeInTheDocument()
    expect(screen.queryByText("API 消费")).not.toBeInTheDocument()
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
    expect(screen.queryByRole("status")).not.toBeInTheDocument()
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
    expect(screen.queryByRole("status")).not.toBeInTheDocument()
  })

  it("shows Stop in a minimal child composer while the child session is active", async () => {
    const user = userEvent.setup()
    const client = renderComposer({ minimal: true, status: { type: "busy" } })

    expect(screen.queryByRole("button", { name: "发送" })).not.toBeInTheDocument()
    await user.click(screen.getByRole("button", { name: "停止" }))

    expect(client.session.abort).toHaveBeenCalledWith({ directory, sessionID }, { throwOnError: true })
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
    await waitFor(() => expect(screen.getByRole("button", { name: "停止" })).toBeVisible())
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

  it("reorders queued prompts by dragging an item onto its new position", async () => {
    const user = userEvent.setup()
    const client = renderComposer({ status: { type: "busy" } })
    const textbox = screen.getByRole("textbox", { name: "消息" })
    await user.type(textbox, "first queued{Enter}")
    await user.type(textbox, "second queued{Enter}")

    const transfer = {
      effectAllowed: "none",
      dropEffect: "none",
      setData: vi.fn(),
      getData: vi.fn(() => ""),
    }
    fireEvent.dragStart(screen.getByText("second queued").closest("li")!, { dataTransfer: transfer })
    fireEvent.dragOver(screen.getByText("first queued").closest("li")!, { dataTransfer: transfer })
    fireEvent.drop(screen.getByText("first queued").closest("li")!, { dataTransfer: transfer, clientY: 0 })

    client.setStatus({ type: "idle" })
    await waitFor(() => expect(client.session.promptAsync).toHaveBeenCalledOnce())
    expect((client.session.promptAsync.mock.calls[0]![0] as { parts: unknown }).parts).toEqual([
      { type: "text", text: "second queued" },
    ])
  })

  it("interrupts the active turn and immediately guides with the selected queued prompt", async () => {
    const user = userEvent.setup()
    const client = renderComposer({ status: { type: "busy" } })
    const textbox = screen.getByRole("textbox", { name: "消息" })
    await user.type(textbox, "keep queued{Enter}")
    await user.type(textbox, "guide now{Enter}")

    await user.click(screen.getByRole("button", { name: "立即引导排队消息 2" }))

    await waitFor(() => expect(client.session.abort).toHaveBeenCalledOnce())
    await waitFor(() => expect(client.session.promptAsync).toHaveBeenCalledOnce())
    expect((client.session.promptAsync.mock.calls[0]![0] as { parts: unknown }).parts).toEqual([
      { type: "text", text: "guide now" },
    ])
    expect(screen.getByText("keep queued")).toBeVisible()
    expect(screen.queryByText("guide now")).not.toBeInTheDocument()
  })

  it("keeps queue controls active while a non-automatic permission request is pending", async () => {
    const user = userEvent.setup()
    const client = renderComposer({ status: { type: "idle" }, requestPending: true })
    const textbox = screen.getByRole("textbox", { name: "消息" })
    await user.type(textbox, "approve-mode queue{Enter}")

    expect(client.session.promptAsync).not.toHaveBeenCalled()
    expect(screen.getByRole("button", { name: "立即引导排队消息 1" })).toBeVisible()
    expect(screen.getByText("approve-mode queue").closest("li")).toHaveAttribute("draggable", "true")

    await user.click(screen.getByRole("button", { name: "立即引导排队消息 1" }))
    await waitFor(() => expect(client.session.abort).toHaveBeenCalledOnce())
    await waitFor(() => expect(client.session.promptAsync).toHaveBeenCalledOnce())
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

  it("does not reserve an empty generation-status row", () => {
    renderComposer()
    expect(screen.queryByRole("status")).not.toBeInTheDocument()
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
    expect(screen.queryByRole("status")).not.toBeInTheDocument()
  })
})
