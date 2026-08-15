import type { PublicProvider } from "@jyycode-ai/sdk/v2/client"
import { cleanup, render, screen, waitFor } from "@solidjs/testing-library"
import userEvent from "@testing-library/user-event"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { ProviderConnectButton } from "./provider-connect"

const directory = "C:\\work\\demo"

function provider(id: string, name: string): PublicProvider {
  return { id, name, source: "config", env: [], options: {}, models: {} }
}

function renderConnect() {
  const client = {
    provider: {
      list: vi.fn(async () => ({
        data: {
          all: [provider("anthropic", "Anthropic"), provider("deepseek", "DeepSeek")],
          connected: [],
          default: {},
        },
      })),
    },
    auth: { set: vi.fn(async () => ({ data: true })) },
    instance: { dispose: vi.fn(async () => ({ data: true })) },
  }
  const onConnected = vi.fn(async () => undefined)
  render(() => <ProviderConnectButton client={client as never} directory={directory} onConnected={onConnected} />)
  return { client, onConnected }
}

afterEach(() => cleanup())

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

describe("ProviderConnectButton", () => {
  it("opens provider selection and returns from the API-key page", async () => {
    const user = userEvent.setup()
    renderConnect()

    await user.click(screen.getAllByRole("button", { name: "连接" }).at(-1)!)
    const search = screen.getByRole("searchbox", { name: "搜索模型提供商" })
    await user.type(search, "anth")
    expect(screen.getByRole("button", { name: /Anthropic/ })).toBeVisible()
    expect(screen.queryByRole("button", { name: /DeepSeek/ })).not.toBeInTheDocument()
    await user.clear(search)
    await user.click(await screen.findByRole("button", { name: /DeepSeek/ }))
    expect(screen.getByLabelText("API 密钥")).toBeVisible()

    await user.click(screen.getByRole("button", { name: "返回提供商列表" }))
    expect(screen.queryByLabelText("API 密钥")).not.toBeInTheDocument()
    expect(screen.getByRole("button", { name: /Anthropic/ })).toBeVisible()
  })

  it("uses the shared close button from the provider list", async () => {
    const user = userEvent.setup()
    renderConnect()

    await user.click(screen.getByRole("button", { name: "连接" }))
    expect(screen.queryByRole("button", { name: "返回提供商列表" })).not.toBeInTheDocument()
    await user.click(screen.getByRole("button", { name: "关闭" }))

    expect(screen.queryByRole("dialog")).not.toBeInTheDocument()
  })

  it("stores the API key, reloads the instance, and closes", async () => {
    const user = userEvent.setup()
    const { client, onConnected } = renderConnect()

    await user.click(screen.getByRole("button", { name: "连接" }))
    await user.click(await screen.findByRole("button", { name: /DeepSeek/ }))
    await user.type(screen.getByLabelText("API 密钥"), "secret-key")
    await user.click(screen.getAllByRole("button", { name: "连接" }).at(-1)!)

    await waitFor(() =>
      expect(client.auth.set).toHaveBeenCalledWith(
        { providerID: "deepseek", auth: { type: "api", key: "secret-key" } },
        { throwOnError: true },
      ),
    )
    expect(client.instance.dispose).toHaveBeenCalledWith({ directory }, { throwOnError: true })
    expect(onConnected).toHaveBeenCalledWith("deepseek")
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument()
    expect(screen.queryByDisplayValue("secret-key")).not.toBeInTheDocument()
  })
})
