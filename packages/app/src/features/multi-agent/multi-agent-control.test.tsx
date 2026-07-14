import type { AgentClusterConfig, Session } from "@jyycode-ai/sdk/v2/client"
import { cleanup, render, screen, waitFor } from "@solidjs/testing-library"
import userEvent from "@testing-library/user-event"
import { createDesktopQueryClient } from "../../data/query-client"
import { keys } from "../../data/query-keys"
import { afterEach, describe, expect, it, vi } from "vitest"
import { effectiveMultiAgent, MultiAgentControl } from "./multi-agent-control"

const directory = "C:\\work\\demo"
const session: Session = {
  id: "ses_root",
  slug: "root",
  projectID: "project_1",
  directory,
  title: "Root session",
  version: "test",
  time: { created: 1, updated: 1 },
}

function renderControl(input?: {
  session?: Session
  config?: AgentClusterConfig
  reject?: boolean
  onPaneChange?: (pane: "multi-agent") => void
}) {
  const queryClient = createDesktopQueryClient()
  const activeSession = input?.session ?? session
  queryClient.setQueryData(keys.session(directory, activeSession.id), activeSession)
  queryClient.setQueryData(keys.sessions(directory), [activeSession])
  queryClient.setQueryData(keys.sessions(directory, true), [])
  const update = input?.reject
    ? vi.fn(async () => {
        throw new Error("update failed")
      })
    : vi.fn(async (value: { multiAgent: boolean }) => ({
        data: { ...activeSession, multiAgent: value.multiAgent },
      }))
  const onPaneChange = input?.onPaneChange ?? vi.fn()
  render(() => (
    <MultiAgentControl
      client={{ session: { update } } as never}
      queryClient={queryClient}
      directory={directory}
      session={activeSession}
      config={input?.config ?? { enabled: true, default_on: false }}
      onOpenPanel={() => onPaneChange("multi-agent")}
      counts={{ running: 2, done: 3, failed: 1 }}
    />
  ))
  return { queryClient, update, onPaneChange }
}

afterEach(cleanup)

describe("effectiveMultiAgent", () => {
  it("uses the Session override before the inherited global default", () => {
    expect(effectiveMultiAgent(session, { enabled: true, default_on: false })).toBe(false)
    expect(effectiveMultiAgent(session, { enabled: true, default_on: true })).toBe(true)
    expect(effectiveMultiAgent({ ...session, multiAgent: false }, { enabled: true, default_on: true })).toBe(false)
  })
})

describe("MultiAgentControl", () => {
  it("toggles an inherited false value on and patches exact Session caches", async () => {
    const user = userEvent.setup()
    const { queryClient, update } = renderControl()
    const toggle = screen.getByRole("switch", { name: "Multi-Agent" })
    expect(toggle).toHaveAttribute("aria-checked", "false")

    await user.click(toggle)

    expect(update).toHaveBeenCalledWith(
      { directory, sessionID: "ses_root", multiAgent: true },
      { throwOnError: true },
    )
    expect(toggle).toHaveAttribute("aria-checked", "true")
    expect(queryClient.getQueryData<Session>(keys.session(directory, "ses_root"))?.multiAgent).toBe(true)
    expect(queryClient.getQueryData<Session[]>(keys.sessions(directory))?.[0]?.multiAgent).toBe(true)
  })

  it("toggles an inherited true value off", async () => {
    const user = userEvent.setup()
    const { update } = renderControl({ config: { enabled: true, default_on: true } })

    await user.click(screen.getByRole("switch", { name: "Multi-Agent" }))

    expect(update).toHaveBeenCalledWith(
      { directory, sessionID: "ses_root", multiAgent: false },
      { throwOnError: true },
    )
  })

  it("restores the effective state and shows an inline error when persistence fails", async () => {
    const user = userEvent.setup()
    renderControl({ reject: true })
    const toggle = screen.getByRole("switch", { name: "Multi-Agent" })

    await user.click(toggle)

    expect(await screen.findByRole("alert")).toHaveTextContent("update failed")
    await waitFor(() => expect(toggle).toHaveAttribute("aria-checked", "false"))
  })

  it.each([
    [{ ...session, parentID: "ses_parent" }, { enabled: true }, "子 Agent 不支持启动 Multi-Agent"],
    [{ ...session, title: "Email: Process inbox" }, { enabled: true }, "邮件 Session 不支持 Multi-Agent"],
    [session, { enabled: false }, "Multi-Agent 已在全局配置中禁用"],
  ] as const)("disables unsupported Session modes with a reason", (value, config, reason) => {
    renderControl({ session: value, config })

    expect(screen.getByRole("switch", { name: "Multi-Agent" })).toBeDisabled()
    expect(screen.getByText(reason)).toBeVisible()
  })

  it("opens the panel independently and renders compact running counts", async () => {
    const user = userEvent.setup()
    const { update, onPaneChange } = renderControl()

    expect(screen.getByText("2 运行 · 3 完成 · 1 失败")).toBeVisible()
    await user.click(screen.getByRole("button", { name: "查看 Multi-Agent" }))

    expect(onPaneChange).toHaveBeenCalledWith("multi-agent")
    expect(update).not.toHaveBeenCalled()
  })
})
