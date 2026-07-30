import type { Session, SessionStatus } from "@jyycode-ai/sdk/v2/client"
import { cleanup, fireEvent, render, screen, waitFor, within } from "@solidjs/testing-library"
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

  it("keeps the workspace running while a delegated assignment is active", () => {
    const { container } = render(() => (
      <SessionWorkspace
        session={session}
        status={{ type: "idle" }}
        assignments={[
          {
            id: "assignment_active",
            sessionID: session.id,
            runPlanID: "plan_active",
            nodeID: "task_active",
            agentID: "role:coder",
            role: "coder",
            workspaceID: "workflow/task_active",
            status: "running",
            createdAt: 1,
            updatedAt: 2,
          } as any,
        ]}
      />
    ))

    expect(container.querySelector(".session-workbench__status")).toHaveAttribute("data-tone", "running")
  })

  it("hosts the task toolbar in the top header without a duplicate canvas shelf", () => {
    const { container } = render(() => (
      <SessionWorkspace
        session={session}
        commandBar={<button type="button">模型与工具</button>}
        requestArea={<div>权限请求</div>}
      />
    ))

    const header = container.querySelector(".session-workbench__header")!
    expect(header.querySelector(".session-workbench__command-bar")).toHaveTextContent("模型与工具")
    expect(container.querySelector(".session-workbench__request-area")).toHaveTextContent("权限请求")
    expect(container.querySelector(".session-workbench__control-shelf")).not.toBeInTheDocument()
  })

  it("shows one orchestrator and no invented main-agent children for unassigned plan tasks", () => {
    const { container } = render(() => (
      <SessionWorkspace
        session={session}
        runPlan={{
          id: "plan_agents",
          sessionID: session.id,
          workflowID: "workflow-creation",
          workflowVersion: "2.0.0",
          version: 1,
          mode: "multi",
          goal: "Create a website workflow",
          tasks: ["interview", "specification", "validation"].map((id) => ({
            id,
            stageID: "requirements",
            stepID: id,
            title: id,
            dependsOn: [],
            acceptance: [],
            status: "planned",
          })),
          createdAt: 1,
          updatedAt: 1,
        } as any}
      />
    ))

    fireEvent.click(container.querySelector<HTMLElement>('[data-module="agents"]')!)

    const graph = screen.getByRole("list", { name: "智能体协作图" })
    expect(graph.querySelectorAll('[role="listitem"]')).toHaveLength(1)
    expect(within(graph).getByRole("button", { name: /主智能体/ })).toBeInTheDocument()
    expect(graph).toHaveTextContent("尚未分配协作智能体")
  })

  it("projects authoritative plan progress onto collaborator nodes", () => {
    const { container } = render(() => (
      <SessionWorkspace
        session={session}
        runPlan={{
          id: "plan_completed",
          sessionID: session.id,
          workflowID: "general",
          workflowVersion: "2.0.0",
          version: 2,
          mode: "multi",
          goal: "Complete delegated work",
          tasks: [{
            id: "task_completed",
            stageID: "implementation",
            stepID: "step-1",
            title: "Completed task",
            dependsOn: [],
            acceptance: [],
            status: "accepted",
          }],
          createdAt: 1,
          updatedAt: 2,
        } as any}
        assignments={[{
          id: "assignment_completed",
          sessionID: session.id,
          runPlanID: "plan_completed",
          nodeID: "task_completed",
          agentID: "role:coder",
          role: "coder",
          workspaceID: "workflow/task_completed",
          status: "assigned",
          createdAt: 1,
          updatedAt: 1,
        } as any]}
      />
    ))

    fireEvent.click(container.querySelector<HTMLElement>('[data-module="agents"]')!)

    expect(container.querySelector('.agent-flow__nodes button[data-status="completed"]')).toBeInTheDocument()
  })

  it("opens module details from the complete card without separate expansion controls", () => {
    const { container } = renderWorkspace()

    expect(container.querySelectorAll(".workbench-module-card")).toHaveLength(7)
    expect(container.querySelector(".workbench-live-panel__open")).not.toBeInTheDocument()
    const plan = container.querySelector<HTMLElement>('[data-module="plan"]')!
    expect(container.querySelector('[data-module="plan"].workbench-module-detail')).not.toBeInTheDocument()
    fireEvent.click(plan)

    expect(container.querySelector('[data-module="plan"].workbench-module-detail')).toBeInTheDocument()
    expect(screen.queryByText("Next step")).not.toBeInTheDocument()
  })

  it("keeps the blackboard read-only for users", () => {
    const onPublishBlackboard = vi.fn(async () => undefined)
    const { container } = render(() => (
      <SessionWorkspace
        session={session}
        blackboard={[]}
        {...({ onPublishBlackboard } as any)}
      />
    ))

    fireEvent.click(container.querySelector<HTMLElement>('[data-module="blackboard"]')!)

    expect(container.querySelector('[data-module="blackboard"].workbench-module-detail')).toBeInTheDocument()
    expect(container.querySelector(".workbench-blackboard__publish")).not.toBeInTheDocument()
    expect(screen.queryByRole("button", { name: "发布到黑板" })).not.toBeInTheDocument()
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
    await waitFor(() =>
      expect(document.querySelector(".workflow-picker summary")).toHaveTextContent("创建工作流"),
    )
  })

})
