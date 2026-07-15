import type { SessionAgentClusterResponse } from "@jyycode-ai/sdk/v2/client"
import { readFileSync } from "node:fs"
import { cleanup, render, screen, within } from "@solidjs/testing-library"
import userEvent from "@testing-library/user-event"
import { afterEach, describe, expect, it, vi } from "vitest"
import { projectAgentClusterState } from "./multi-agent-state"
import { MultiAgentPanelView } from "./multi-agent-panel"

const multiAgentCSS = readFileSync("src/features/multi-agent/multi-agent.css", "utf8")

type Run = SessionAgentClusterResponse["runs"][number]
type Task = SessionAgentClusterResponse["tasks"][number]

function run(overrides: Partial<Run> = {}): Run {
  return {
    id: "run_1",
    session_id: "ses_root",
    parent_message_id: "msg_parent",
    enabled: true,
    status: "dispatching",
    goal: "Deliver the complete Desktop workflow",
    planner_model: "test/planner",
    reviewer_model: "test/reviewer",
    time_created: 1,
    time_updated: 2,
    completed_at: 0,
    ...overrides,
  }
}

function task(overrides: Partial<Task> = {}): Task {
  return {
    id: "code",
    run_id: "run_1",
    parent_task_id: "",
    child_session_id: "ses_child",
    role: "coder",
    title: "Implement the panel",
    prompt: "Implement",
    complexity: "complex",
    model: "test/coder",
    status: "running",
    step: 1,
    dependencies: ["research"],
    review_round: 2,
    acceptance_criteria: ["All tests pass"],
    artifact_paths: ["src/panel.tsx"],
    result_summary: "Panel implemented",
    review_issues: ["Improve focus state"],
    last_event: "Revision started",
    time_created: 2,
    time_updated: 3,
    ...overrides,
  }
}

function snapshot(state?: SessionAgentClusterResponse) {
  return projectAgentClusterState(state ?? { runs: [run()], tasks: [task()] })
}

afterEach(cleanup)

describe("MultiAgentPanelView states", () => {
  it("handles no Session, disabled mode, waiting for a plan, loading, and retryable errors", async () => {
    const user = userEvent.setup()
    const retry = vi.fn()
    const { unmount } = render(() => (
      <MultiAgentPanelView enabled={false} snapshot={snapshot({ runs: [], tasks: [] })} onOpenChild={vi.fn()} />
    ))
    expect(screen.getByText("选择会话后查看多智能体任务")).toBeVisible()
    unmount()

    const disabled = render(() => (
      <MultiAgentPanelView sessionID="ses_root" enabled={false} snapshot={snapshot({ runs: [], tasks: [] })} onOpenChild={vi.fn()} />
    ))
    expect(screen.getByText("当前会话未启用多智能体")).toBeVisible()
    disabled.unmount()

    const waiting = render(() => (
      <MultiAgentPanelView sessionID="ses_root" enabled snapshot={snapshot({ runs: [], tasks: [] })} onOpenChild={vi.fn()} />
    ))
    expect(screen.getByText("正在等待主智能体生成计划")).toBeVisible()
    waiting.unmount()

    const loading = render(() => (
      <MultiAgentPanelView sessionID="ses_root" enabled loading snapshot={snapshot({ runs: [], tasks: [] })} onOpenChild={vi.fn()} />
    ))
    expect(screen.getByRole("status")).toHaveTextContent("正在加载多智能体任务")
    loading.unmount()

    render(() => (
      <MultiAgentPanelView
        sessionID="ses_root"
        enabled
        error="cluster unavailable"
        snapshot={snapshot({ runs: [], tasks: [] })}
        onRetry={retry}
        onOpenChild={vi.fn()}
      />
    ))
    expect(screen.getByRole("alert")).toHaveTextContent("cluster unavailable")
    await user.click(screen.getByRole("button", { name: "重试" }))
    expect(retry).toHaveBeenCalledOnce()
  })

  it.each([
    ["planning", "规划中"],
    ["dispatching", "派发中"],
    ["reviewing", "复核中"],
    ["synthesizing", "汇总中"],
    ["completed", "已完成"],
    ["failed", "失败"],
    ["cancelled", "已取消"],
  ] as const)("renders run status %s", (status, label) => {
    render(() => (
      <MultiAgentPanelView
        sessionID="ses_root"
        enabled
        snapshot={snapshot({ runs: [run({ status })], tasks: [] })}
        onOpenChild={vi.fn()}
      />
    ))
    expect(screen.getByText(label)).toBeVisible()
  })
})

describe("MultiAgentPanelView plan and task interactions", () => {
  it("shows status and progress without repeating the task goal above the cards", () => {
    const state: SessionAgentClusterResponse = {
      runs: [run()],
      tasks: [
        task({ id: "done", status: "accepted", step: 1, child_session_id: "" }),
        task({ id: "active", status: "running", step: 2 }),
        task({ id: "failed", status: "failed", step: 3, child_session_id: "" }),
      ],
    }
    render(() => <MultiAgentPanelView sessionID="ses_root" enabled snapshot={snapshot(state)} onOpenChild={vi.fn()} />)

    expect(screen.getByText("派发中")).toBeVisible()
    expect(screen.queryByText("Deliver the complete Desktop workflow")).not.toBeInTheDocument()
    expect(screen.getByRole("progressbar")).toHaveAttribute("aria-valuemin", "0")
    expect(screen.getByRole("progressbar")).toHaveAttribute("aria-valuemax", "3")
    expect(screen.getByRole("progressbar")).toHaveAttribute("aria-valuenow", "1")
    expect(screen.getByText("步骤 2/3 · 1 完成")).toBeVisible()
    expect(screen.getByText("1 运行 · 1 完成 · 1 失败")).toBeVisible()
  })

  it("renders chronological semantic steps with readable tones and full task disclosure", async () => {
    const user = userEvent.setup()
    const state: SessionAgentClusterResponse = {
      runs: [run({ id: "run_2", time_created: 10 }), run({ id: "run_1", time_created: 1 })],
      tasks: [
        task({ id: "queued", title: "Queued task", run_id: "run_1", status: "queued", child_session_id: "", step: 1 }),
        task({ id: "review", title: "Review task", run_id: "run_1", status: "revision_requested", child_session_id: "", step: 2 }),
        task({ id: "done", title: "Done task", run_id: "run_1", status: "accepted", child_session_id: "", step: 3 }),
        task({ id: "failed", title: "Failed task", run_id: "run_1", status: "failed", child_session_id: "", step: 4 }),
        task({ run_id: "run_2", status: "revising", step: 1 }),
      ],
    }
    render(() => <MultiAgentPanelView sessionID="ses_root" enabled snapshot={snapshot(state)} onOpenChild={vi.fn()} />)

    expect(screen.getAllByRole("list", { name: /步骤/ })).toHaveLength(5)
    expect(screen.getAllByText("等待中")[0]).toBeVisible()
    expect(screen.getAllByText("复核中")[0]).toBeVisible()
    expect(screen.getAllByText("已完成")[0]).toBeVisible()
    expect(screen.getAllByText("失败")[0]).toBeVisible()
    expect(screen.getAllByText("运行中")[0]).toBeVisible()

    const queuedRow = screen.getByText("Queued task").closest("li")!
    expect(queuedRow).toHaveAttribute("data-tone", "queued")
    expect(queuedRow).toHaveAttribute("data-selected", "false")
    expect(multiAgentCSS).toMatch(/\.multi-agent-task\[data-tone="queued"\]\s*\{\s*border-color:\s*transparent;/)

    const taskSummary = screen.getByText("Implement the panel")
    await user.click(taskSummary)
    const disclosure = taskSummary.closest("details")!
    expect(within(disclosure).getByText("编码")).toBeVisible()
    expect(within(disclosure).getByText("test/coder")).toBeVisible()
    expect(within(disclosure).getAllByText("修改中")[0]).toBeVisible()
    expect(within(disclosure).getByText("Revision started")).toBeVisible()
    expect(within(disclosure).getByText("research")).toBeVisible()
    expect(within(disclosure).getByText("All tests pass")).toBeVisible()
    expect(within(disclosure).getByText("Panel implemented")).toBeVisible()
    expect(within(disclosure).getByText("Improve focus state")).toBeVisible()
    expect(within(disclosure).getByText("src/panel.tsx")).toBeVisible()
    expect(within(disclosure).getByText("第 2 轮复核")).toBeVisible()
  })

  it("opens only tasks with child Sessions and highlights the selected child", async () => {
    const user = userEvent.setup()
    const onOpenChild = vi.fn()
    const state = snapshot({
      runs: [run()],
      tasks: [task(), task({ id: "local", title: "Local task", child_session_id: "", time_created: 4 })],
    })
    render(() => (
      <MultiAgentPanelView
        sessionID="ses_root"
        enabled
        snapshot={state}
        selectedChildSessionID="ses_child"
        onOpenChild={onOpenChild}
      />
    ))

    const open = screen.getByRole("button", { name: "审阅：Implement the panel" })
    expect(open.closest("li")).toHaveAttribute("data-selected", "true")
    expect(screen.queryByRole("button", { name: "审阅：Local task" })).not.toBeInTheDocument()
    await user.click(open)
    expect(onOpenChild).toHaveBeenCalledWith("ses_child")
  })
})
