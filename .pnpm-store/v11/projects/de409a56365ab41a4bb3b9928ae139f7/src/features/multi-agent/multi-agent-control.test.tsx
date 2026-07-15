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
  render(() => (
    <MultiAgentControl
      client={{ session: { update } } as never}
      queryClient={queryClient}
      directory={directory}
      session={activeSession}
      config={input?.config ?? { enabled: true, default_on: false }}
    />
  ))
  return { queryClient, update }
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
    const toggle = screen.getByRole("switch", { name: "多智能体" })
    expect(toggle).toHaveAttribute("aria-checked", "false")
    expect(toggle.querySelector(".multi-agent-switch__track")).not.toBeInTheDocument()

    await user.click(toggle)

    expect(update).toHaveBeenCalledWith(
      { directory, sessionID: "ses_root", multiAgent: true },
      { throwOnError: true },
    )
    expect(toggle).toHaveAttribute("aria-checked", "true")
    expect(toggle).toHaveAttribute("data-active", "true")
    expect(document.body.querySelector(".multi-agent-activation-wave")).not.toBeInTheDocument()
    expect(queryClient.getQueryData<Session>(keys.session(directory, "ses_root"))?.multiAgent).toBe(true)
    expect(queryClient.getQueryData<Session[]>(keys.sessions(directory))?.[0]?.multiAgent).toBe(true)
  })

  it("toggles an inherited true value off", async () => {
    const user = userEvent.setup()
    const { update } = renderControl({ config: { enabled: true, default_on: true } })

    await user.click(screen.getByRole("switch", { name: "多智能体" }))

    expect(update).toHaveBeenCalledWith(
      { directory, sessionID: "ses_root", multiAgent: false },
      { throwOnError: true },
    )
  })

  it("restores the effective state and shows an inline error when persistence fails", async () => {
    const user = userEvent.setup()
    renderControl({ reject: true })
    const toggle = screen.getByRole("switch", { name: "多智能体" })

    await user.click(toggle)

    expect(await screen.findByRole("alert")).toHaveTextContent("update failed")
    await waitFor(() => expect(toggle).toHaveAttribute("aria-checked", "false"))
  })

  it.each([
    [{ ...session, parentID: "ses_parent" }, { enabled: true }, "子智能体不支持启动多智能体"],
    [{ ...session, title: "Email: Process inbox" }, { enabled: true }, "邮件会话不支持多智能体"],
    [session, { enabled: false }, "多智能体已在全局配置中禁用"],
  ] as const)("disables unsupported Session modes with a reason", (value, config, reason) => {
    renderControl({ session: value, config })

    expect(screen.getByRole("switch", { name: "多智能体" })).toBeDisabled()
    expect(screen.getByText(reason)).toBeVisible()
  })

  it("renders only the Session mode switch without a duplicate panel action or counts", () => {
    const { update } = renderControl()

    expect(screen.queryByRole("button", { name: "查看 Multi-Agent" })).not.toBeInTheDocument()
    expect(screen.queryByText(/运行.*完成.*失败/)).not.toBeInTheDocument()
    expect(update).not.toHaveBeenCalled()
  })
})
