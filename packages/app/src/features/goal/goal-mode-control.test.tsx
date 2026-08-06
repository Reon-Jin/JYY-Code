import type { Session } from "@jyycode-ai/sdk/v2/client"
import { cleanup, render, screen, waitFor } from "@solidjs/testing-library"
import userEvent from "@testing-library/user-event"
import { createDesktopQueryClient } from "../../data/query-client"
import { keys } from "../../data/query-keys"
import { afterEach, describe, expect, it, vi } from "vitest"
import { effectiveGoalRunning, GoalModeControl } from "./goal-mode-control"

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
    : vi.fn(async (value: { goal: Session["goal"] | null }) => ({
        data: { ...activeSession, goal: value.goal ?? undefined },
      }))
  render(() => (
    <GoalModeControl
      client={{ session: { update } } as never}
      queryClient={queryClient}
      directory={directory}
      session={activeSession}
    />
  ))
  return { queryClient, update }
}

afterEach(cleanup)

describe("effectiveGoalRunning", () => {
  it("is true only for running root goals", () => {
    expect(effectiveGoalRunning(session)).toBe(false)
    expect(
      effectiveGoalRunning({ ...session, goal: { condition: "x", status: "running", startedAt: 1, updatedAt: 1 } }),
    ).toBe(true)
    expect(
      effectiveGoalRunning({
        ...session,
        parentID: "ses_parent",
        goal: { condition: "x", status: "running", startedAt: 1, updatedAt: 1 },
      }),
    ).toBe(false)
  })
})

describe("GoalModeControl", () => {
  it("toggles goal mode on and patches caches", async () => {
    const user = userEvent.setup()
    const { queryClient, update } = renderControl()
    const toggle = screen.getByRole("switch")
    expect(toggle).toHaveAttribute("aria-checked", "false")
    await user.click(toggle)

    expect(update).toHaveBeenCalledWith(
      expect.objectContaining({
        directory,
        sessionID: "ses_root",
        goal: expect.objectContaining({ status: "running" }),
      }),
      { throwOnError: true },
    )
    expect(toggle).toHaveAttribute("aria-checked", "true")
    await waitFor(() =>
      expect(queryClient.getQueryData<Session>(keys.session(directory, "ses_root"))?.goal?.status).toBe("running"),
    )
  })

  it("cancels a running goal", async () => {
    const user = userEvent.setup()
    const { update } = renderControl({
      session: {
        ...session,
        goal: { condition: "x", status: "running", startedAt: 1, updatedAt: 1 },
      },
    })

    await user.click(screen.getByRole("switch"))

    expect(update).toHaveBeenCalledWith(
      expect.objectContaining({ goal: expect.objectContaining({ status: "cancelled" }) }),
      { throwOnError: true },
    )
  })

  it("shows an inline error when persistence fails", async () => {
    const user = userEvent.setup()
    renderControl({ reject: true })
    await user.click(screen.getByRole("switch"))

    expect(await screen.findByRole("alert")).toHaveTextContent("update failed")
  })
})
