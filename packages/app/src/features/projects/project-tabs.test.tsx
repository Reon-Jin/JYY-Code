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

function dragProjectTab(source: HTMLElement, target: HTMLElement, clientX: number, release = true) {
  const sourceContainer = source.closest<HTMLElement>("[data-project-directory]")!
  const targetContainer = target.closest<HTMLElement>("[data-project-directory]")!
  vi.spyOn(sourceContainer, "getBoundingClientRect").mockReturnValue({
    bottom: 40,
    height: 40,
    left: 100,
    right: 200,
    top: 0,
    width: 100,
    x: 100,
    y: 0,
    toJSON: () => ({}),
  })
  vi.spyOn(targetContainer, "getBoundingClientRect").mockReturnValue({
    bottom: 40,
    height: 40,
    left: 0,
    right: 100,
    top: 0,
    width: 100,
    x: 0,
    y: 0,
    toJSON: () => ({}),
  })

  fireEvent.pointerDown(source, { button: 0, clientX: 10, clientY: 10, isPrimary: true, pointerId: 1 })
  fireEvent.pointerMove(source, { clientX, clientY: 10, isPrimary: true, pointerId: 1 })
  if (release) fireEvent.pointerUp(source, { clientX, clientY: 10, isPrimary: true, pointerId: 1 })
}

describe("ProjectTabs", () => {
  afterEach(cleanup)

  it("uses POSIX path semantics for macOS project titles", () => {
    const project = opened("/Users/dev/项目\\保留")
    render(() => (
      <ProjectTabs
        projects={[project]}
        activeDirectory={project.directory}
        queryClient={createDesktopQueryClient()}
        onSelect={vi.fn()}
        onOpen={vi.fn()}
        onClose={vi.fn()}
        onReorder={vi.fn()}
      />
    ))

    expect(screen.getByRole("tab", { name: /项目\\保留/ })).toBeVisible()
  })

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
    expect(currentTab.closest("[data-project-directory]")).toHaveAttribute("data-project-directory", current.directory)

    dragProjectTab(currentTab, otherTab, 0, false)

    const currentContainer = currentTab.closest<HTMLElement>("[data-project-directory]")!
    const otherContainer = otherTab.closest<HTMLElement>("[data-project-directory]")!
    expect(currentContainer.style.transform).toContain("translateX(calc(-1")
    expect(otherContainer.style.transform).toContain("translateX(calc(1")
    fireEvent.pointerUp(currentTab, { clientX: 0, clientY: 10, isPrimary: true, pointerId: 1 })

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

    const currentTab = screen.getByRole("tab", { name: /demo/ })
    dragProjectTab(otherTab, currentTab, 0)
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
