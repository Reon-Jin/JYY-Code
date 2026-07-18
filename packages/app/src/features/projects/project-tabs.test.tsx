import type { Project } from "@jyycode-ai/sdk/v2/client"
import { cleanup, fireEvent, render, screen, waitFor } from "@solidjs/testing-library"
import { afterEach, describe, expect, it, vi } from "vitest"
import { createDesktopQueryClient } from "../../data/query-client"
import type { DesktopClient } from "../../data/sdk"
import type { OpenedProject } from "./project-controller"
import { projectStatusTransitions, ProjectTabs } from "./project-tabs"

describe("projectStatusTransitions", () => {
  it("reports lifecycle changes and treats a missing running session as complete", () => {
    expect(projectStatusTransitions({}, { ses_1: { type: "busy" } })).toEqual([
      { sessionID: "ses_1", status: "running" },
    ])
    const retry = { type: "retry" as const, attempt: 1, message: "retrying", next: 1 }
    expect(projectStatusTransitions({ ses_1: { type: "busy" } }, { ses_1: retry })).toEqual([
      { sessionID: "ses_1", status: "retry" },
    ])
    expect(projectStatusTransitions({ ses_1: retry }, {})).toEqual([
      { sessionID: "ses_1", status: "idle" },
    ])
    expect(projectStatusTransitions({ ses_1: { type: "busy" } }, { ses_1: { type: "busy" } })).toEqual([])
  })
})

function opened(directory: string, running = false): OpenedProject {
  const info: Project = {
    id: `project-${directory}`,
    worktree: directory,
    time: { created: 1, updated: 1 },
    sandboxes: [],
  }
  const client = {
    session: {
      status: vi.fn(async () => ({ data: running ? { ses_1: { type: "busy" as const } } : {} })),
    },
  } as unknown as DesktopClient
  return { directory, info, client }
}

describe("ProjectTabs", () => {
  afterEach(cleanup)

  it("keeps the active tab enabled so it can be dragged to a new position", () => {
    const current = opened("C:\\work\\active-drag-source")
    const other = opened("C:\\work\\active-drag-target")
    const onReorder = vi.fn()
    render(() => (
      <ProjectTabs
        projects={[other, current]}
        activeDirectory={current.directory}
        queryClient={createDesktopQueryClient()}
        onSelect={vi.fn()}
        onOpen={vi.fn()}
        onClose={vi.fn()}
        onReorder={onReorder}
      />
    ))

    const currentTab = screen.getByRole("tab", { name: /active-drag-source/ })
    const otherTab = screen.getByRole("tab", { name: /active-drag-target/ })
    expect(currentTab).not.toBeDisabled()

    fireEvent.dragStart(currentTab)
    fireEvent.dragOver(otherTab, { clientX: 0 })
    fireEvent.drop(otherTab)

    expect(onReorder).toHaveBeenCalledWith(current.directory, other.directory, "before")
  })

  it("renders compact open-project tabs, running state, and direct selection", async () => {
    const current = opened("C:\\work\\demo")
    const other = opened("C:\\work\\other", true)
    const onSelect = vi.fn()
    const onOpen = vi.fn()
    const onClose = vi.fn()
    const onReorder = vi.fn()
    render(() => (
      <ProjectTabs
        projects={[current, other]}
        activeDirectory={current.directory}
        queryClient={createDesktopQueryClient()}
        onSelect={onSelect}
        onOpen={onOpen}
        onClose={onClose}
        onReorder={onReorder}
      />
    ))

    expect(screen.getByRole("tab", { name: /demo/ })).toHaveAttribute("aria-selected", "true")
    const otherTab = screen.getByRole("tab", { name: /other/ })
    await waitFor(() => expect(otherTab).toHaveAttribute("data-state", "running"))
    otherTab.click()
    expect(onSelect).toHaveBeenCalledWith(other.directory)
    screen.getByRole("button", { name: /打开目录/ }).click()
    expect(onOpen).toHaveBeenCalledOnce()
    screen.getByRole("button", { name: /关闭项目 other/ }).click()
    expect(onClose).toHaveBeenCalledWith(other.directory)
    expect(onSelect).toHaveBeenCalledOnce()

    fireEvent.dragStart(otherTab)
    const currentTab = screen.getByRole("tab", { name: /demo/ })
    fireEvent.dragOver(currentTab, { clientX: 0 })
    fireEvent.drop(currentTab)
    expect(onReorder).toHaveBeenCalledWith(other.directory, current.directory, "before")
  })

  it("keeps the last confirmed running state while a remounted query reconnects", async () => {
    const directory = "C:\\work\\stable-status"
    const project = opened(directory, true)
    const first = render(() => (
      <ProjectTabs
        projects={[project]}
        activeDirectory="C:\\work\\other"
        queryClient={createDesktopQueryClient()}
        onSelect={vi.fn()}
        onOpen={vi.fn()}
        onClose={vi.fn()}
        onReorder={vi.fn()}
      />
    ))
    await waitFor(() => expect(screen.getByRole("tab", { name: /stable-status/ })).toHaveAttribute("data-state", "running"))
    first.unmount()

    project.client.session.status = vi.fn(() => new Promise(() => undefined)) as typeof project.client.session.status
    render(() => (
      <ProjectTabs
        projects={[project]}
        activeDirectory="C:\\work\\other"
        queryClient={createDesktopQueryClient()}
        onSelect={vi.fn()}
        onOpen={vi.fn()}
        onClose={vi.fn()}
        onReorder={vi.fn()}
      />
    ))

    expect(screen.getByRole("tab", { name: /stable-status/ })).toHaveAttribute("data-state", "running")
  })
})
