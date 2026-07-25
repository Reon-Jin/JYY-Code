import type { McpStatus } from "@jyycode-ai/sdk/v2/client"
import { cleanup, render, screen, waitFor } from "@solidjs/testing-library"
import userEvent from "@testing-library/user-event"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { createDesktopQueryClient } from "../../data/query-client"
import { McpControl } from "./mcp-control"

const directory = "C:\\work\\demo"

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

function renderControl(initial: Record<string, McpStatus>) {
  let statuses = structuredClone(initial)
  const client = {
    mcp: {
      status: vi.fn(async () => ({ data: structuredClone(statuses) })),
      connect: vi.fn(async ({ name }: { name: string }) => {
        statuses[name] = { status: "connected" }
        return { data: true }
      }),
      disconnect: vi.fn(async ({ name }: { name: string }) => {
        statuses[name] = { status: "disabled" }
        return { data: true }
      }),
    },
  }
  render(() => <McpControl client={client as never} queryClient={createDesktopQueryClient()} directory={directory} />)
  return client
}

beforeEach(installDialog)

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

describe("McpControl", () => {
  it("opens installed MCP servers in a closeable dialog", async () => {
    const user = userEvent.setup()
    renderControl({ filesystem: { status: "connected" }, browser: { status: "disabled" } })

    await user.click(screen.getByRole("button", { name: "MCP" }))

    const dialog = await screen.findByRole("dialog", { name: "MCP 插件" })
    expect(screen.getByRole("switch", { name: "filesystem" })).toHaveAttribute("aria-checked", "true")
    expect(screen.getByRole("switch", { name: "browser" })).toHaveAttribute("aria-checked", "false")
    expect(dialog).not.toHaveTextContent("已启用")
    expect(dialog).toHaveTextContent("已关闭")

    await user.click(screen.getByRole("button", { name: "关闭" }))
    await waitFor(() => expect(dialog).not.toHaveAttribute("open"))
  })

  it("connects disabled MCP servers and disconnects connected servers", async () => {
    const user = userEvent.setup()
    const client = renderControl({ filesystem: { status: "connected" }, browser: { status: "disabled" } })
    await user.click(screen.getByRole("button", { name: "MCP" }))

    await user.click(await screen.findByRole("switch", { name: "browser" }))
    expect(client.mcp.connect).toHaveBeenCalledWith({ directory, name: "browser" }, { throwOnError: true })
    await waitFor(() => expect(screen.getByRole("switch", { name: "browser" })).toHaveAttribute("aria-checked", "true"))

    await user.click(screen.getByRole("switch", { name: "filesystem" }))
    expect(client.mcp.disconnect).toHaveBeenCalledWith({ directory, name: "filesystem" }, { throwOnError: true })
    await waitFor(() =>
      expect(screen.getByRole("switch", { name: "filesystem" })).toHaveAttribute("aria-checked", "false"),
    )
  })

  it("shows a retryable inline failure without closing the dialog", async () => {
    const user = userEvent.setup()
    const client = renderControl({ browser: { status: "disabled" } })
    client.mcp.connect.mockRejectedValueOnce(new Error("connection failed"))
    await user.click(screen.getByRole("button", { name: "MCP" }))

    await user.click(await screen.findByRole("switch", { name: "browser" }))

    expect(await screen.findByRole("alert")).toHaveTextContent("connection failed")
    expect(screen.getByRole("dialog", { name: "MCP 插件" })).toHaveAttribute("open")
    expect(screen.getByRole("switch", { name: "browser" })).toHaveAttribute("aria-checked", "false")
  })
})
