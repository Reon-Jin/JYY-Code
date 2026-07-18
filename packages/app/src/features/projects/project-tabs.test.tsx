import type { Project } from "@jyycode-ai/sdk/v2/client"
import { cleanup, render, screen, waitFor } from "@solidjs/testing-library"
import { afterEach, describe, expect, it, vi } from "vitest"
import { createDesktopQueryClient } from "../../data/query-client"
import type { DesktopClient } from "../../data/sdk"
import type { OpenedProject } from "./project-controller"
import { ProjectTabs } from "./project-tabs"

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

  it("renders compact open-project tabs, running state, and direct selection", async () => {
    const current = opened("C:\\work\\demo")
    const other = opened("C:\\work\\other", true)
    const onSelect = vi.fn()
    const onOpen = vi.fn()
    render(() => (
      <ProjectTabs
        projects={[current, other]}
        activeDirectory={current.directory}
        queryClient={createDesktopQueryClient()}
        onSelect={onSelect}
        onOpen={onOpen}
      />
    ))

    expect(screen.getByRole("tab", { name: /demo/ })).toHaveAttribute("aria-selected", "true")
    const otherTab = screen.getByRole("tab", { name: /other/ })
    await waitFor(() => expect(otherTab).toHaveAttribute("data-state", "running"))
    otherTab.click()
    expect(onSelect).toHaveBeenCalledWith(other.directory)
    screen.getByRole("button", { name: /打开目录/ }).click()
    expect(onOpen).toHaveBeenCalledOnce()
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
      />
    ))

    expect(screen.getByRole("tab", { name: /stable-status/ })).toHaveAttribute("data-state", "running")
  })
})
