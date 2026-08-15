import type { GlobalCompaction } from "@jyycode-ai/sdk/v2/client"
import { QueryClientProvider } from "@tanstack/solid-query"
import { cleanup, render, screen, waitFor } from "@solidjs/testing-library"
import userEvent from "@testing-library/user-event"
import { afterEach, describe, expect, it, vi } from "vitest"
import { createDesktopQueryClient } from "../../data/query-client"
import type { ManagementContextValue } from "../management/management-context"
import { CompactionSettings } from "./compaction-settings"

const defaults: GlobalCompaction = {
  auto: true,
  prune: true,
  tailTurns: 2,
  triggerRatio: 0.92,
  microCompact: true,
  microCompactMaxChars: 8000,
  reactiveCompact: true,
}

function management(input?: {
  value?: GlobalCompaction
  update?: (value: GlobalCompaction) => Promise<GlobalCompaction>
  reset?: () => Promise<GlobalCompaction>
}) {
  let value = input?.value ?? defaults
  const client = {
    global: {
      compaction: {
        get: vi.fn(async () => ({ data: value })),
        update: vi.fn(async ({ globalCompaction }: { globalCompaction: GlobalCompaction }) => {
          value = await (input?.update?.(globalCompaction) ?? Promise.resolve(globalCompaction))
          return { data: value }
        }),
        reset: vi.fn(async () => {
          value = await (input?.reset?.() ?? Promise.resolve(defaults))
          return { data: value }
        }),
      },
    },
  }
  return {
    client,
    queryClient: createDesktopQueryClient(),
    directory: "C:\\Users\\dev",
  } as unknown as ManagementContextValue & { client: typeof client }
}

function renderSettings(value = management()) {
  render(() => (
    <QueryClientProvider client={value.queryClient}>
      <CompactionSettings management={value} />
    </QueryClientProvider>
  ))
  return value
}

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

describe("CompactionSettings", () => {
  it("loads safe compaction values without exposing raw JSON", async () => {
    renderSettings(management({ value: { ...defaults, preserveRecentTokens: 0, reservedTokens: 16000 } }))

    expect(await screen.findByRole("checkbox", { name: "自动压缩" })).toBeChecked()
    expect(screen.getByRole("checkbox", { name: "清理旧工具输出" })).toBeChecked()
    await userEvent.click(screen.getByText("高级参数", { selector: "summary" }))
    expect(screen.getByRole("spinbutton", { name: "保留最近轮次" })).toHaveValue(2)
    expect(screen.getByRole("spinbutton", { name: "保留最近 Token" })).toHaveValue(0)
    expect(screen.getByRole("spinbutton", { name: "预留 Token" })).toHaveValue(16000)
    expect(screen.queryByRole("textbox", { name: /JSON/i })).not.toBeInTheDocument()
  })

  it("saves a valid changed draft and explains when it takes effect", async () => {
    const value = renderSettings()
    const user = userEvent.setup()
    const auto = await screen.findByRole("checkbox", { name: "自动压缩" })

    await user.click(auto)
    await user.click(screen.getByRole("button", { name: "保存压缩参数" }))

    await waitFor(() =>
      expect(value.client.global.compaction.update).toHaveBeenCalledWith(
        { globalCompaction: { ...defaults, auto: false } },
        { throwOnError: true },
      ),
    )
    expect(await screen.findByText("已保存；新会话将使用新参数。")).toBeVisible()
  })

  it("blocks invalid numeric fields without requesting the backend", async () => {
    const value = renderSettings()
    const user = userEvent.setup()
    await screen.findByRole("checkbox", { name: "自动压缩" })
    await user.click(screen.getByText("高级参数", { selector: "summary" }))
    const tailTurns = screen.getByRole("spinbutton", { name: "保留最近轮次" })

    await user.clear(tailTurns)
    await user.type(tailTurns, "21")

    expect(screen.getByText("请输入 0 到 20 之间的整数。")).toBeVisible()
    expect(screen.getByRole("button", { name: "保存压缩参数" })).toBeDisabled()
    expect(value.client.global.compaction.update).not.toHaveBeenCalled()
  })

  it("rolls the draft back when saving fails", async () => {
    renderSettings(
      management({
        update: async () => {
          throw new Error("save failed")
        },
      }),
    )
    const user = userEvent.setup()
    const auto = await screen.findByRole("checkbox", { name: "自动压缩" })

    await user.click(auto)
    await user.click(screen.getByRole("button", { name: "保存压缩参数" }))

    await waitFor(() => expect(auto).toBeChecked())
    expect(screen.getByRole("alert")).toHaveTextContent("save failed")
  })

  it("confirms reset, deletes only the override, and refreshes the query", async () => {
    const value = renderSettings(management({ value: { ...defaults, tailTurns: 8 } }))
    const user = userEvent.setup()
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(true)
    await screen.findByRole("checkbox", { name: "自动压缩" })

    await user.click(screen.getByRole("button", { name: "恢复安全默认值" }))

    expect(confirm).toHaveBeenCalledWith("这会删除自定义压缩配置并恢复安全默认值。是否继续？")
    await waitFor(() => expect(value.client.global.compaction.reset).toHaveBeenCalledWith({ throwOnError: true }))
    await waitFor(() => expect(value.client.global.compaction.get.mock.calls.length).toBeGreaterThan(1))
    expect(await screen.findByText("已恢复安全默认值；新会话将使用新参数。")).toBeVisible()
  })
})
