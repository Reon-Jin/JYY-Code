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
import type { Config } from "@jyycode-ai/sdk/v2"

function management(
  shell = "cmd",
  directory = "C:\\Users\\dev",
  config = "C:\\Users\\dev\\.config\\jyycode",
  timeoutMs?: number,
) {
  let stored: Config = { shell, ...(timeoutMs === undefined ? {} : { subagents: { timeout_ms: timeoutMs } }) }
  const client = {
    auth: { status: vi.fn(async () => ({ data: { active: false } })) },
    global: {
      config: {
        get: vi.fn(async () => ({ data: structuredClone(stored) })),
        update: vi.fn(async ({ config }: { config: Config }) => {
          stored = { ...stored, ...config, subagents: { ...stored.subagents, ...config.subagents } }
          return { data: structuredClone(stored) }
        }),
      },
      compaction: {
        get: vi.fn(async () => ({
          data: {
            auto: true,
            prune: true,
            tailTurns: 2,
            triggerRatio: 0.92,
            microCompact: true,
            microCompactMaxChars: 8000,
            reactiveCompact: true,
          },
        })),
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
      <Route
        path="/"
        component={() => (
          <DesktopBridgeProvider bridge={desktop.bridge}>
            <QueryClientProvider client={value.queryClient}>
              <AdvancedSettings management={value} />
            </QueryClientProvider>
          </DesktopBridgeProvider>
        )}
      />
    </MemoryRouter>
  ))
  return { value, desktop }
}

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

describe("AdvancedSettings", () => {
  it("defaults to 60 minutes, persists a user limit, and reloads it", async () => {
    const { value } = renderAdvanced()
    const user = userEvent.setup()
    const input = await screen.findByRole("spinbutton", { name: "执行时限（分钟）" })
    await waitFor(() => expect(input).toBeEnabled())
    expect(input).toHaveValue(60)
    expect(screen.getByRole("button", { name: "保存执行时限" })).toBeDisabled()
    await user.clear(input)
    await user.type(input, "30")
    await user.click(screen.getByRole("button", { name: "保存执行时限" }))
    await waitFor(() =>
      expect(value.client.global.config.update).toHaveBeenCalledWith(
        { config: { subagents: { timeout_ms: 1_800_000 } } },
        { throwOnError: true },
      ),
    )
    expect(await screen.findByText("已保存；新派发和重试的子 Agent 将使用新时限。")).toBeVisible()
    cleanup()
    renderAdvanced(value)
    await waitFor(() => expect(screen.getByRole("spinbutton", { name: "执行时限（分钟）" })).toHaveValue(30))
  })

  it("blocks empty, nonpositive, fractional and over-limit values without writing config", async () => {
    const { value } = renderAdvanced()
    const user = userEvent.setup()
    const input = await screen.findByRole("spinbutton", { name: "执行时限（分钟）" })
    await waitFor(() => expect(input).toBeEnabled())
    for (const invalid of ["", "0", "-1", "1.5", "61"]) {
      await user.clear(input)
      if (invalid) await user.type(input, invalid)
      expect(screen.getByRole("button", { name: "保存执行时限" })).toBeDisabled()
      expect(input).toHaveAttribute("aria-invalid", "true")
    }
    expect(value.client.global.config.update).not.toHaveBeenCalled()
  })

  it("shows persisted settings and retains an unsaved edit when saving fails", async () => {
    const value = management("cmd", "C:\\Users\\dev", "C:\\Users\\dev\\.config\\jyycode", 1_200_000)
    value.client.global.config.update.mockRejectedValueOnce(new Error("保存失败"))
    renderAdvanced(value)
    const user = userEvent.setup()
    const input = await screen.findByRole("spinbutton", { name: "执行时限（分钟）" })
    await waitFor(() => expect(input).toHaveValue(20))
    await user.clear(input)
    await user.type(input, "45")
    await user.click(screen.getByRole("button", { name: "保存执行时限" }))
    expect(await screen.findByText("保存失败")).toBeVisible()
    expect(input).toHaveValue(45)
    expect(screen.getByRole("button", { name: "保存执行时限" })).toBeEnabled()
    expect(screen.queryByText("已保存；新派发和重试的子 Agent 将使用新时限。")).not.toBeInTheDocument()
  })

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
    const updateSettings = document.querySelector(".update-settings")!
    expect(updateSettings.querySelector("select")).toBeEnabled()
    expect(updateSettings.querySelector("button")).toBeEnabled()

    await user.click(screen.getByRole("button", { name: "打开全局配置文件" }))
    expect(desktop.bridge.revealConfigFile).toHaveBeenCalledWith("/Users/dev/.config/jyycode/jyycode.jsonc")
  })
})
