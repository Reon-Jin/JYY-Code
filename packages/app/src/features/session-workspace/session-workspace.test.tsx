import type { Session, SessionStatus } from "@jyycode-ai/sdk/v2/client"
import { cleanup, fireEvent, render, screen, waitFor } from "@solidjs/testing-library"
import { afterEach, describe, expect, it, vi } from "vitest"
import { SessionWorkspace } from "./session-workspace"

const session: Session = {
  id: "ses_workspace",
  slug: "workspace",
  projectID: "pro_workspace",
  directory: "C:\\work\\workspace",
  title: "Workspace regression coverage",
  version: "test",
  time: { created: 1, updated: 1 },
}

function renderWorkspace(status: SessionStatus = { type: "idle" }) {
  return render(() => <SessionWorkspace session={session} status={status} />)
}

afterEach(cleanup)

describe("SessionWorkspace", () => {
  it("renders a newly opened session before plan data exists", () => {
    const { container } = renderWorkspace()

    expect(container.querySelector(".session-workbench")).toBeInTheDocument()
    expect(container.querySelector(".session-workbench__chat")).toBeInTheDocument()
    expect(container.querySelector(".session-dock")).not.toBeInTheDocument()
    expect(container.querySelectorAll('[data-tone="ready"]').length).toBeGreaterThan(0)
  })

  it("renders a busy session without generating a dynamic i18n key", () => {
    const { container } = renderWorkspace({ type: "busy" })

    expect(container.querySelectorAll('[data-tone="running"]').length).toBeGreaterThan(0)
  })

  it("keeps seven Chinese workbench modules visible and smoothly opens their details", () => {
    const { container } = renderWorkspace()

    expect(container.querySelectorAll(".workbench-module-card")).toHaveLength(7)
    const plan = container.querySelector<HTMLElement>('[data-module="plan"]')!
    const openPlan = plan.querySelector<HTMLButtonElement>(".workbench-live-panel__open")!
    expect(container.querySelector('[data-module="plan"].workbench-module-detail')).not.toBeInTheDocument()
    fireEvent.click(openPlan)

    expect(container.querySelector('[data-module="plan"].workbench-module-detail')).toBeInTheDocument()
    expect(screen.queryByText("Next step")).not.toBeInTheDocument()
  })

  it("selects the built-in workflow through the workbench control", async () => {
    const onSelectWorkflow = vi.fn(async () => undefined)
    render(() => (
      <SessionWorkspace
        session={session}
        runPlan={{
          id: "plan_workspace",
          sessionID: session.id,
          workflowID: "general",
          workflowVersion: "2.0.0",
          version: 1,
          mode: "single",
          goal: "Test workflow selection",
          tasks: [],
          createdAt: 1,
          updatedAt: 1,
        } as any}
        onSelectWorkflow={onSelectWorkflow}
      />
    ))

    fireEvent.click(document.querySelector<HTMLElement>(".workflow-picker summary")!)
    fireEvent.click(screen.getByRole("menuitemradio", { name: /创建工作流/ }))

    await waitFor(() => expect(onSelectWorkflow).toHaveBeenCalledWith("workflow-creation", "2.0.0"))
  })

})
