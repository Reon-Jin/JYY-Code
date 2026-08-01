import type { Session } from "@jyycode-ai/sdk/v2/client"
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

function renderControl(input?: { session?: Session; reject?: boolean }) {
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
    />
  ))
  return { queryClient, update }
}

afterEach(cleanup)

describe("effectiveMultiAgent", () => {
  it("uses only the Session mode and disables child Sessions", () => {
    expect(effectiveMultiAgent(session)).toBe(false)
    expect(effectiveMultiAgent({ ...session, multiAgent: true })).toBe(true)
    expect(effectiveMultiAgent({ ...session, parentID: "ses_parent", multiAgent: true })).toBe(false)
  })
})

describe("MultiAgentControl", () => {
  it("toggles a false value on and patches exact Session caches", async () => {
    const user = userEvent.setup()
    const { queryClient, update } = renderControl()
    const toggle = screen.getByRole("switch")
    expect(toggle).toHaveAttribute("aria-checked", "false")

    await user.click(toggle)

    expect(update).toHaveBeenCalledWith({ directory, sessionID: "ses_root", multiAgent: true }, { throwOnError: true })
    expect(toggle).toHaveAttribute("aria-checked", "true")
    expect(queryClient.getQueryData<Session>(keys.session(directory, "ses_root"))?.multiAgent).toBe(true)
    expect(queryClient.getQueryData<Session[]>(keys.sessions(directory))?.[0]?.multiAgent).toBe(true)
  })

  it("toggles a persisted true value off", async () => {
    const user = userEvent.setup()
    const { update } = renderControl({ session: { ...session, multiAgent: true } })

    await user.click(screen.getByRole("switch"))

    expect(update).toHaveBeenCalledWith({ directory, sessionID: "ses_root", multiAgent: false }, { throwOnError: true })
  })

  it("restores state and shows an inline error when persistence fails", async () => {
    const user = userEvent.setup()
    renderControl({ reject: true })
    const toggle = screen.getByRole("switch")

    await user.click(toggle)

    expect(await screen.findByRole("alert")).toHaveTextContent("update failed")
    await waitFor(() => expect(toggle).toHaveAttribute("aria-checked", "false"))
  })

  it("disables multi-agent mode for child Sessions", () => {
    renderControl({ session: { ...session, parentID: "ses_parent" } })
    expect(screen.getByRole("switch")).toBeDisabled()
  })
})
