import type { Session } from "@jyycode-ai/sdk/v2/client"
import { MemoryRouter, Route } from "@solidjs/router"
import { cleanup, fireEvent, render, screen, within } from "@solidjs/testing-library"
import { afterEach, describe, expect, it, vi } from "vitest"
import { projectShortcutIndex, WorkspaceLayoutView } from "./workspace-layout"

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

  it("provides an accessible Session workbench with all operational modules", () => {
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

    const plan = document.querySelector<HTMLButtonElement>('.workbench-module-card[data-module="plan"]')!
    expect(document.querySelectorAll(".workbench-module-card")).toHaveLength(7)
    fireEvent.click(plan)
    expect(plan).toHaveAttribute("aria-expanded", "true")
    expect(screen.getAllByText(/尚未生成可执行方案/)).not.toHaveLength(0)
    expect(screen.getByRole("region", { name: "Active Session" })).toBeInTheDocument()
  })

  it("waits for the requested Session instead of mounting the workspace with an undefined session", () => {
    render(() => (
      <MemoryRouter>
        <Route
          path="/*all"
          component={() => (
            <WorkspaceLayoutView
              projectName="demo"
              projectDirectory={session.directory}
              connection="connected"
              activeSessions={[]}
              archivedSessions={[]}
              statuses={{}}
              activeSessionID="ses_loading"
              activeLoading
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

    expect(screen.queryByRole("heading", { name: "Active Session" })).not.toBeInTheDocument()
    expect(within(document.querySelector(".session-empty")!).getByRole("button", { name: "新建会话" })).toBeDisabled()
  })

  it("switches projects with Tab on the conversation canvas and Ctrl+1-9 globally", () => {
    const switchProject = vi.fn(async () => undefined)
    render(() => (
      <MemoryRouter>
        <Route
          path="/*all"
          component={() => (
            <WorkspaceLayoutView
              projectName="demo"
              projectDirectory={session.directory}
              openProjectDirectories={[session.directory, "C:\\work\\other"]}
              connection="connected"
              activeSessions={[session]}
              archivedSessions={[]}
              statuses={{}}
              onReturnHome={vi.fn(async () => undefined)}
              onSwitchProject={switchProject}
              onCreate={vi.fn(async () => undefined)}
              onRename={vi.fn(async () => undefined)}
              onArchive={vi.fn(async () => undefined)}
              onDelete={vi.fn(async () => undefined)}
            />
          )}
        />
      </MemoryRouter>
    ))

    const main = document.querySelector<HTMLElement>(".workspace-main")!
    main.focus()
    fireEvent.keyDown(main, { key: "Tab" })
    expect(switchProject).toHaveBeenCalledWith("C:\\work\\other")

    expect(
      projectShortcutIndex(
        { key: "1", ctrlKey: true, altKey: false, metaKey: false, shiftKey: false, target: document.body },
        1,
        2,
      ),
    ).toBe(0)

    const input = document.createElement("input")
    main.append(input)
    expect(
      projectShortcutIndex(
        { key: "Tab", ctrlKey: false, altKey: false, metaKey: false, shiftKey: false, target: input },
        0,
        2,
      ),
    ).toBe(1)

    const button = document.createElement("button")
    main.append(button)
    expect(
      projectShortcutIndex(
        { key: "Tab", ctrlKey: false, altKey: false, metaKey: false, shiftKey: false, target: button },
        0,
        2,
      ),
    ).toBe(1)

    const dialog = document.createElement("div")
    dialog.setAttribute("role", "dialog")
    const dialogButton = document.createElement("button")
    dialog.append(dialogButton)
    main.append(dialog)
    expect(
      projectShortcutIndex(
        { key: "Tab", ctrlKey: false, altKey: false, metaKey: false, shiftKey: false, target: dialogButton },
        0,
        2,
      ),
    ).toBeUndefined()
  })
})
