import type { PermissionRuleset, Session } from "@jyycode-ai/sdk/v2/client"
import { cleanup, render, screen, waitFor } from "@solidjs/testing-library"
import userEvent from "@testing-library/user-event"
import { afterEach, describe, expect, it, vi } from "vitest"
import { createDesktopQueryClient } from "../../data/query-client"
import { keys } from "../../data/query-keys"
import { AgentPermissionControl } from "./agent-permission-control"

const directory = "C:\\work\\demo"
const baseSession: Session = {
  id: "ses_permission",
  slug: "permission",
  projectID: "project_1",
  directory,
  title: "Permission session",
  version: "test",
  time: { created: 1, updated: 1 },
}

afterEach(cleanup)

describe("AgentPermissionControl", () => {
  it("switches from another permission mode back to automatic and clears the override", async () => {
    const user = userEvent.setup()
    const queryClient = createDesktopQueryClient()
    let persisted: Session = baseSession
    queryClient.setQueryData(keys.session(directory, persisted.id), persisted)
    queryClient.setQueryData(keys.sessionsAll(directory), [persisted])
    const update = vi.fn(async (input: { permission: PermissionRuleset }) => {
      persisted = { ...persisted, permission: input.permission }
      return { data: persisted }
    })

    render(() => (
      <AgentPermissionControl
        client={{ session: { update } } as never}
        queryClient={queryClient}
        directory={directory}
        session={baseSession}
      />
    ))

    await user.click(screen.getByRole("button", { name: "Agent 权限：自动模式" }))
    await user.click(screen.getByRole("menuitemradio", { name: /所有权限/ }))
    await waitFor(() => expect(screen.getByRole("button", { name: "Agent 权限：所有权限" })).toBeVisible())

    await user.click(screen.getByRole("button", { name: "Agent 权限：所有权限" }))
    await user.click(screen.getByRole("menuitemradio", { name: /自动模式/ }))

    await waitFor(() => expect(screen.getByRole("button", { name: "Agent 权限：自动模式" })).toBeVisible())
    expect(update).toHaveBeenNthCalledWith(
      1,
      { directory, sessionID: baseSession.id, permission: [{ permission: "*", pattern: "*", action: "allow" }] },
      { throwOnError: true },
    )
    expect(update).toHaveBeenNthCalledWith(
      2,
      { directory, sessionID: baseSession.id, permission: [] },
      { throwOnError: true },
    )
    expect(queryClient.getQueryData<Session>(keys.session(directory, baseSession.id))?.permission).toEqual([])
    expect(queryClient.getQueryData<Session[]>(keys.sessionsAll(directory))?.[0]?.permission).toEqual([])
  })
})
