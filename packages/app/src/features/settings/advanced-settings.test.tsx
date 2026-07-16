import { QueryClientProvider } from "@tanstack/solid-query"
import { cleanup, render, screen, waitFor } from "@solidjs/testing-library"
import userEvent from "@testing-library/user-event"
import { afterEach, describe, expect, it, vi } from "vitest"
import { createDesktopQueryClient } from "../../data/query-client"
import { DesktopBridgeProvider } from "../../platform/context"
import { createFakeDesktop } from "../../test/fake-desktop"
import type { ManagementContextValue } from "../management/management-context"
import { AdvancedSettings } from "./advanced-settings"

function management(shell = "cmd") {
  const client = {
    global: {
      config: {
        get: vi.fn(async () => ({ data: { shell } })),
        update: vi.fn(async ({ config }: { config: { shell: string } }) => ({ data: config })),
      },
    },
    path: {
      get: vi.fn(async () => ({ data: { config: "C:\\Users\\dev\\.config\\jyycode" } })),
    },
  }
  return { client, queryClient: createDesktopQueryClient(), directory: "C:\\Users\\dev" } as unknown as
    ManagementContextValue & { client: typeof client }
}

function renderAdvanced(value = management()) {
  const desktop = createFakeDesktop()
  render(() => (
    <DesktopBridgeProvider bridge={desktop.bridge}>
      <QueryClientProvider client={value.queryClient}>
        <AdvancedSettings management={value} />
      </QueryClientProvider>
    </DesktopBridgeProvider>
  ))
  return { value, desktop }
}

afterEach(() => { cleanup(); vi.restoreAllMocks() })

describe("AdvancedSettings", () => {
  it("updates the default Shell and reveals the validated global config path", async () => {
    const { value, desktop } = renderAdvanced()
    const user = userEvent.setup()

    const shell = await screen.findByRole("combobox", { name: "默认 Shell" })
    await waitFor(() => expect(shell).toBeEnabled())
    await user.selectOptions(shell, "pwsh")
    await waitFor(() => expect(value.client.global.config.update).toHaveBeenCalledWith(
      { config: { shell: "pwsh" } },
      { throwOnError: true },
    ))

    await user.click(screen.getByRole("button", { name: "打开全局配置文件" }))
    expect(desktop.bridge.revealConfigFile).toHaveBeenCalledWith(
      "C:\\Users\\dev\\.config\\jyycode\\jyycode.jsonc",
    )
  })

  it("preserves an unrecognized existing Shell and disables deferred settings", async () => {
    renderAdvanced(management("nu"))

    expect(await screen.findByRole("option", { name: "当前值：nu" })).toBeInTheDocument()
    expect(screen.getByLabelText("自动更新策略")).toBeDisabled()
    expect(screen.getByRole("button", { name: "配置上下文压缩参数" })).toBeDisabled()
    expect(screen.getByRole("button", { name: "管理记忆" })).toBeDisabled()
  })
})
