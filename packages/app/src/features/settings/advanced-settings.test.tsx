import { QueryClientProvider } from "@tanstack/solid-query"
import { MemoryRouter, Route } from "@solidjs/router"
import { cleanup, render, screen, waitFor } from "@solidjs/testing-library"
import userEvent from "@testing-library/user-event"
import { afterEach, describe, expect, it, vi } from "vitest"
import { createDesktopQueryClient } from "../../data/query-client"
import { DesktopBridgeProvider } from "../../platform/context"
import { createFakeDesktop } from "../../test/fake-desktop"
import type { ManagementContextValue } from "../management/management-context"
import { AdvancedSettings } from "./advanced-settings"

function management(shell = "cmd", directory = "C:\\Users\\dev", config = "C:\\Users\\dev\\.config\\jyycode") {
  const client = {
    global: {
      config: {
        get: vi.fn(async () => ({ data: { shell } })),
        update: vi.fn(async ({ config }: { config: { shell: string } }) => ({ data: config })),
      },
      compaction: {
        get: vi.fn(async () => ({ data: {
          auto: true,
          prune: true,
          tailTurns: 2,
          triggerRatio: 0.92,
          microCompact: true,
          microCompactMaxChars: 8000,
          reactiveCompact: true,
        } })),
        update: vi.fn(),
        reset: vi.fn(),
      },
      memory: {
        list: vi.fn(async () => ({ data: { entries: [], total: 0 } })),
        update: vi.fn(),
        remove: vi.fn(),
        compact: vi.fn(),
        export: vi.fn(),
        user: { create: vi.fn() },
        task: { clear: vi.fn() },
      },
    },
    path: {
      get: vi.fn(async () => ({ data: { config } })),
    },
  }
  return { client, queryClient: createDesktopQueryClient(), directory } as unknown as ManagementContextValue & {
    client: typeof client
  }
}

function macManagement(shell = "zsh") {
  return management(shell, "/Users/dev", "/Users/dev/.config/jyycode")
}

function renderAdvanced(value = management()) {
  const desktop = createFakeDesktop()
  render(() => (
    <MemoryRouter>
      <Route path="/" component={() => (
        <DesktopBridgeProvider bridge={desktop.bridge}>
          <QueryClientProvider client={value.queryClient}>
            <AdvancedSettings management={value} />
          </QueryClientProvider>
        </DesktopBridgeProvider>
      )} />
    </MemoryRouter>
  ))
  return { value, desktop }
}

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

describe("AdvancedSettings", () => {
  it("updates the default Shell and reveals the validated global config path", async () => {
    const { value, desktop } = renderAdvanced()
    const user = userEvent.setup()

    const shell = await screen.findByRole("combobox", { name: "默认 Shell" })
    await waitFor(() => expect(shell).toBeEnabled())
    await user.selectOptions(shell, "pwsh")
    await waitFor(() =>
      expect(value.client.global.config.update).toHaveBeenCalledWith(
        { config: { shell: "pwsh" } },
        { throwOnError: true },
      ),
    )

    await user.click(screen.getByRole("button", { name: "打开全局配置文件" }))
    expect(desktop.bridge.revealConfigFile).toHaveBeenCalledWith("C:\\Users\\dev\\.config\\jyycode\\jyycode.jsonc")
  })

  it("preserves an unrecognized existing Shell and exposes updater controls", async () => {
    renderAdvanced(management("nu"))

    expect(await screen.findByRole("option", { name: "当前值：nu" })).toBeInTheDocument()
    expect(screen.getByLabelText("自动更新策略")).toHaveValue("notify")
    expect(screen.getByRole("button", { name: "立即检查" })).toBeVisible()
    expect(screen.getByRole("heading", { name: "上下文压缩参数" })).toBeVisible()
    expect(screen.queryByRole("button", { name: "配置上下文压缩参数" })).not.toBeInTheDocument()
    expect(screen.getByRole("heading", { name: "记忆管理" })).toBeVisible()
    expect(screen.getByRole("link", { name: /用户记忆/ })).toBeVisible()
    expect(screen.getByRole("link", { name: /任务记忆/ })).toBeVisible()
    expect(screen.queryByText("用户偏好简体中文。")).not.toBeInTheDocument()
  })

  it("offers macOS shells and reveals the Finder-compatible config path", async () => {
    const { desktop } = renderAdvanced(macManagement())
    const user = userEvent.setup()
    await screen.findByRole("combobox", { name: "默认 Shell" })

    expect(screen.getByRole("option", { name: "zsh" })).toBeInTheDocument()
    expect(screen.getByRole("option", { name: "bash" })).toBeInTheDocument()
    expect(screen.queryByRole("option", { name: "cmd" })).not.toBeInTheDocument()
    expect(screen.getByLabelText("自动更新策略")).toBeDisabled()
    expect(screen.getByRole("button", { name: "立即检查" })).toBeDisabled()
    expect(screen.getByText("macOS 预览版暂不提供自动更新")).toBeVisible()

    await user.click(screen.getByRole("button", { name: "打开全局配置文件" }))
    expect(desktop.bridge.revealConfigFile).toHaveBeenCalledWith("/Users/dev/.config/jyycode/jyycode.jsonc")
  })
})
