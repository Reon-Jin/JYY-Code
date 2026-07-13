import type { Session, SessionStatus } from "@jyycode-ai/sdk/v2/client"
import { MemoryRouter, Route } from "@solidjs/router"
import { cleanup, render, screen, waitFor, within } from "@solidjs/testing-library"
import userEvent from "@testing-library/user-event"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { WorkspaceLayoutView } from "../../layout/workspace-layout"
import { SessionList } from "./session-list"

const directory = "C:\\work\\demo"

function session(id: string, title: string, updated: number): Session {
  return {
    id,
    slug: id,
    projectID: "project_1",
    directory,
    title,
    version: "test",
    time: { created: 1, updated },
  }
}

const older = session("ses_old", "Older session", 10)
const newer = session("ses_new", "Newer session", 20)

function renderList(overrides?: Partial<Parameters<typeof SessionList>[0]>) {
  const props = {
    sessions: [older, newer],
    statuses: {} as Record<string, SessionStatus>,
    activeSessionID: newer.id,
    archived: false,
    onCreate: vi.fn(async () => undefined),
    onRename: vi.fn(async () => undefined),
    onArchive: vi.fn(async () => undefined),
    onDelete: vi.fn(async () => undefined),
    ...overrides,
  }

  render(() => (
    <MemoryRouter>
      <Route path="*" component={() => <SessionList {...props} />} />
    </MemoryRouter>
  ))
  return props
}

describe("SessionList", () => {
  beforeEach(() => {
    Object.defineProperties(HTMLDialogElement.prototype, {
      close: {
        configurable: true,
        value(this: HTMLDialogElement) {
          this.removeAttribute("open")
          this.dispatchEvent(new Event("close"))
        },
      },
      showModal: {
        configurable: true,
        value(this: HTMLDialogElement) {
          this.setAttribute("open", "")
        },
      },
    })
  })

  afterEach(() => {
    cleanup()
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
  })

  it("sorts roots by most recently updated and marks the active route", () => {
    renderList()

    const links = screen.getAllByRole("link")
    expect(links.map((link) => link.textContent)).toEqual([
      expect.stringContaining("Newer session"),
      expect.stringContaining("Older session"),
    ])
    expect(screen.getByRole("link", { name: /Newer session/ })).toHaveAttribute("aria-current", "page")
  })

  it("validates an inline rename without closing the editor", async () => {
    const user = userEvent.setup()
    const props = renderList()

    await user.click(screen.getByRole("button", { name: "Session 操作：Newer session" }))
    await user.click(screen.getByRole("menuitem", { name: "重命名" }))
    const input = screen.getByRole("textbox", { name: "重命名 Newer session" })
    await user.clear(input)
    await user.click(screen.getByRole("button", { name: "保存名称" }))

    expect(screen.getByRole("alert")).toHaveTextContent("名称不能为空")
    expect(input).toBeVisible()
    expect(props.onRename).not.toHaveBeenCalled()
  })

  it("keeps a Session visible until archive succeeds", async () => {
    const user = userEvent.setup()
    let finish: () => void = () => {}
    const onArchive = vi.fn(
      () => new Promise<void>((resolve) => {
        finish = resolve
      }),
    )
    renderList({ onArchive })

    await user.click(screen.getByRole("button", { name: "Session 操作：Newer session" }))
    await user.click(screen.getByRole("menuitem", { name: "归档" }))

    expect(screen.getByRole("link", { name: /Newer session/ })).toBeVisible()
    expect(screen.getByRole("menuitem", { name: "正在归档" })).toHaveAttribute("aria-busy", "true")
    finish()
    await waitFor(() => expect(screen.queryByRole("menu")).not.toBeInTheDocument())
  })

  it("cancels and confirms deletion from a named dialog", async () => {
    const user = userEvent.setup()
    const props = renderList()

    await user.click(screen.getByRole("button", { name: "Session 操作：Newer session" }))
    await user.click(screen.getByRole("menuitem", { name: "删除" }))
    const dialog = screen.getByRole("dialog", { name: "删除 Session" })
    expect(within(dialog).getByText(/Newer session/)).toBeVisible()
    await user.click(within(dialog).getByRole("button", { name: "取消" }))
    expect(props.onDelete).not.toHaveBeenCalled()

    await user.click(screen.getByRole("button", { name: "Session 操作：Newer session" }))
    await user.click(screen.getByRole("menuitem", { name: "删除" }))
    await user.click(screen.getByRole("button", { name: "永久删除" }))
    await waitFor(() => expect(props.onDelete).toHaveBeenCalledWith(newer.id))
  })

  it("starts collapsed on a narrow window and exposes a labeled toggle", async () => {
    vi.stubGlobal("matchMedia", vi.fn(() => ({ matches: true })))
    const user = userEvent.setup()
    render(() => (
      <MemoryRouter>
        <Route
          path="*"
          component={() => (
            <WorkspaceLayoutView
              projectName="demo"
              projectDirectory={directory}
              connection="connected"
              activeSessions={[newer]}
              archivedSessions={[]}
              statuses={{}}
              onSwitchProject={vi.fn(async () => undefined)}
              onCreate={vi.fn(async () => undefined)}
              onRename={vi.fn(async () => undefined)}
              onArchive={vi.fn(async () => undefined)}
              onDelete={vi.fn(async () => undefined)}
            />
          )}
        />
      </MemoryRouter>
    ))

    const toggle = screen.getByRole("button", { name: "展开 Session 导航" })
    expect(screen.getByRole("complementary", { hidden: true })).toHaveAttribute("aria-hidden", "true")
    await user.click(toggle)
    expect(screen.getByRole("button", { name: "收起 Session 导航" })).toHaveAttribute("aria-expanded", "true")
    expect(screen.getByRole("complementary")).toHaveAttribute("aria-hidden", "false")
  })
})
