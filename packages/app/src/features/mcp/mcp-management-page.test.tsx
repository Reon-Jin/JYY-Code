import type { McpLocalConfig, McpRemoteConfig, McpStatus } from "@jyycode-ai/sdk/v2/client"
import { QueryClientProvider } from "@tanstack/solid-query"
import { cleanup, render, screen, waitFor, within } from "@solidjs/testing-library"
import userEvent from "@testing-library/user-event"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { createDesktopQueryClient } from "../../data/query-client"
import type { ManagementContextValue } from "../management/management-context"
import { McpManagementPage } from "./mcp-management-page"

const directory = "C:\\Users\\test"
const configs: Record<string, McpLocalConfig | McpRemoteConfig> = {
  broken: { type: "local", command: ["bunx", "broken", "--stdio"], enabled: true, timeout: 8_000 },
  remote: {
    type: "remote",
    url: "https://mcp.example.com/api",
    headers: { "X-Team": "desktop" },
    enabled: false,
    oauth: { clientId: "desktop-client", clientSecret: "do-not-render", scope: "read" },
  },
}
const statuses: Record<string, McpStatus> = {
  broken: { status: "failed", error: "connection refused" },
  remote: { status: "needs_auth" },
}

function installDialog() {
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
}

function management() {
  let current = structuredClone(configs)
  const client = {
    mcp: {
      config: {
        list: vi.fn(async () => ({ data: structuredClone(current) })),
        update: vi.fn(async ({ name, body }: { name: string; body: McpLocalConfig | McpRemoteConfig }) => {
          current[name] = structuredClone(body)
          return { data: true }
        }),
        delete: vi.fn(async ({ name }: { name: string }) => {
          delete current[name]
          return { data: true }
        }),
      },
      status: vi.fn(async () => ({ data: structuredClone(statuses) })),
      connect: vi.fn(async () => ({ data: true })),
      auth: {
        authenticate: vi.fn(async () => ({ data: true })),
        remove: vi.fn(async () => ({ data: true })),
      },
    },
  }
  return { client, queryClient: createDesktopQueryClient(), directory } as unknown as ManagementContextValue & {
    client: typeof client
  }
}

function renderPage(value = management()) {
  render(() => (
    <QueryClientProvider client={value.queryClient}>
      <McpManagementPage management={value} />
    </QueryClientProvider>
  ))
  return value
}

beforeEach(installDialog)
afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

describe("McpManagementPage", () => {
  it("merges configuration and status, persists switches, retries one server, and keeps other rows available", async () => {
    const user = userEvent.setup()
    const value = renderPage()

    expect(screen.getByRole("heading", { name: "MCP" })).toBeVisible()
    expect(await screen.findByText("连接失败")).toBeVisible()
    expect(screen.getByText("需要认证")).toBeVisible()
    expect(screen.getByText("本地")).toBeVisible()
    expect(screen.getByText("远程")).toBeVisible()
    expect(screen.getByText("bunx broken --stdio")).toBeVisible()
    expect(screen.getByText("mcp.example.com")).toBeVisible()

    await user.click(screen.getByRole("switch", { name: "启用 remote" }))
    expect(value.client.mcp.config.update).toHaveBeenCalledWith(
      { directory, name: "remote", body: expect.objectContaining({ type: "remote", enabled: true }) },
      { throwOnError: true },
    )

    let finish!: () => void
    value.client.mcp.connect.mockImplementationOnce(
      () => new Promise((resolve) => (finish = () => resolve({ data: true }))),
    )
    await user.click(screen.getByRole("button", { name: "重试 broken" }))
    expect(screen.getByRole("button", { name: "重试 broken" })).toBeDisabled()
    expect(screen.getByRole("button", { name: "编辑 remote" })).toBeEnabled()
    finish()
    await waitFor(() =>
      expect(value.client.mcp.connect).toHaveBeenCalledWith({ directory, name: "broken" }, { throwOnError: true }),
    )
  })

  it("adds a local server with ordered arguments and environment rows", async () => {
    const user = userEvent.setup()
    const value = renderPage()
    await screen.findByText("连接失败")
    await user.click(screen.getByRole("button", { name: "添加 MCP" }))

    const dialog = screen.getByRole("dialog", { name: "添加 MCP" })
    await user.type(within(dialog).getByLabelText("名称"), "filesystem")
    await user.type(within(dialog).getByLabelText("可执行命令"), "bunx")
    await user.type(within(dialog).getByLabelText("参数 1"), "@modelcontextprotocol/server-filesystem")
    await user.click(within(dialog).getByRole("button", { name: "添加参数" }))
    await user.type(within(dialog).getByLabelText("参数 2"), "C:\\work")
    await user.click(within(dialog).getByRole("button", { name: "添加环境变量" }))
    await user.type(within(dialog).getByLabelText("环境变量名称 1"), "LOG_LEVEL")
    await user.type(within(dialog).getByLabelText("环境变量值 1"), "debug")
    await user.click(within(dialog).getByRole("button", { name: "保存" }))

    await waitFor(() =>
      expect(value.client.mcp.config.update).toHaveBeenCalledWith(
        {
          directory,
          name: "filesystem",
          body: expect.objectContaining({
            type: "local",
            command: ["bunx", "@modelcontextprotocol/server-filesystem", "C:\\work"],
            environment: { LOG_LEVEL: "debug" },
          }),
        },
        { throwOnError: true },
      ),
    )
    expect(dialog).not.toHaveAttribute("open")
  })

  it("edits remote headers and OAuth without echoing a stored client secret", async () => {
    const user = userEvent.setup()
    const value = renderPage()
    await screen.findByText("需要认证")
    await user.click(screen.getByRole("button", { name: "编辑 remote" }))

    const dialog = screen.getByRole("dialog", { name: "编辑 MCP remote" })
    expect(within(dialog).getByLabelText("客户端密钥")).toHaveValue("")
    expect(dialog).not.toHaveTextContent("do-not-render")
    await user.clear(within(dialog).getByLabelText("请求头值 1"))
    await user.type(within(dialog).getByLabelText("请求头值 1"), "app")
    await user.type(within(dialog).getByLabelText("客户端密钥"), "replacement")
    await user.click(within(dialog).getByRole("button", { name: "保存" }))

    await waitFor(() =>
      expect(value.client.mcp.config.update).toHaveBeenCalledWith(
        {
          directory,
          name: "remote",
          body: expect.objectContaining({
            type: "remote",
            headers: { "X-Team": "app" },
            oauth: expect.objectContaining({ clientId: "desktop-client", clientSecret: "replacement" }),
          }),
        },
        { throwOnError: true },
      ),
    )

    await user.click(screen.getByRole("button", { name: "认证 remote" }))
    expect(value.client.mcp.auth.authenticate).toHaveBeenCalledWith(
      { directory, name: "remote" },
      { throwOnError: true },
    )
    await user.click(screen.getByRole("button", { name: "移除认证 remote" }))
    expect(value.client.mcp.auth.remove).toHaveBeenCalledWith({ directory, name: "remote" }, { throwOnError: true })
  })

  it("keeps a failed mutation dialog open and deletes persisted configuration after confirmation", async () => {
    const user = userEvent.setup()
    const value = renderPage()
    value.client.mcp.config.update.mockRejectedValueOnce(new Error("write denied"))
    await screen.findByText("连接失败")
    await user.click(screen.getByRole("button", { name: "编辑 broken" }))
    const edit = screen.getByRole("dialog", { name: "编辑 MCP broken" })
    await user.click(within(edit).getByRole("button", { name: "保存" }))
    expect(await within(edit).findByRole("alert")).toHaveTextContent("write denied")
    expect(edit).toHaveAttribute("open")
    await user.click(within(edit).getByRole("button", { name: "关闭" }))

    await user.click(screen.getByRole("button", { name: "删除 broken" }))
    const confirm = screen.getByRole("dialog", { name: "删除 MCP broken" })
    await user.click(within(confirm).getByRole("button", { name: "确认删除" }))
    await waitFor(() =>
      expect(value.client.mcp.config.delete).toHaveBeenCalledWith(
        { directory, name: "broken" },
        { throwOnError: true },
      ),
    )
    expect(confirm).not.toHaveAttribute("open")
  })
})
