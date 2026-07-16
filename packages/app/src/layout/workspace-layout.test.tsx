import type { Session } from "@jyycode-ai/sdk/v2/client"
import { MemoryRouter, Route } from "@solidjs/router"
import { cleanup, render, screen } from "@solidjs/testing-library"
import { afterEach, describe, expect, it, vi } from "vitest"
import { WorkspaceLayoutView } from "./workspace-layout"

const session: Session = {
  id: "ses_1",
  slug: "session-1",
  projectID: "pro_1",
  directory: "C:\\work\\demo",
  title: "Active Session",
  version: "test",
  time: { created: 1, updated: 1 },
}

describe("WorkspaceLayoutView settings entry", () => {
  afterEach(cleanup)

  it("returns Settings to the active Session", () => {
    render(() => (
      <MemoryRouter>
        <Route
          path="/*all"
          component={() => (
            <WorkspaceLayoutView
              projectName="demo"
              projectDirectory={session.directory}
              connection="connected"
              activeSessions={[session]}
              archivedSessions={[]}
              statuses={{}}
              activeSession={session}
              activeSessionID={session.id}
              onReturnHome={vi.fn(async () => undefined)}
              onCreate={vi.fn(async () => undefined)}
              onRename={vi.fn(async () => undefined)}
              onArchive={vi.fn(async () => undefined)}
              onDelete={vi.fn(async () => undefined)}
            />
          )}
        />
      </MemoryRouter>
    ))

    expect(screen.getByRole("link", { name: "打开设置" })).toHaveAttribute(
      "href",
      "/settings/general?returnTo=%2Fsession%2Fses_1",
    )
  })
})
