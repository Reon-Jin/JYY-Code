/** @jsxImportSource @opentui/solid */
// Plan 抽屉 — 与 desktop features/plan/plan-panel.tsx 对齐。
// projectPlanState 归约逻辑移植自 packages/app/src/features/plan/plan-state.ts（去掉 i18n tr，使用中文标签）。
import type { TuiPlugin, TuiPluginApi } from "@jyycode-ai/plugin/tui"
import type { SessionPlanResponse } from "@jyycode-ai/sdk/v2"
import type { RGBA } from "@opentui/core"
import { useBindings } from "@tui/keymap"
import { useTheme } from "@tui/context/theme"
import { useTerminalDimensions } from "@opentui/solid"
import { createResource, createSignal, For, onCleanup, Show } from "solid-js"

export const ROUTE = "plan"

// ---------- 纯逻辑（可测；移植自 desktop plan-state.ts） ----------

type PlanData = Exclude<SessionPlanResponse, { plan: null }>
type PlanTask = PlanData["steps"][number]["tasks"][number]

export type PlanTaskTone = "queued" | "running" | "review" | "done" | "failed"

export type PlanTaskView = {
  key: string
  id: string
  step: number
  title: string
  status: PlanTask["status"]
  tone: PlanTaskTone
  statusLabel: string
  childSessionID?: string
}

export type PlanStepView = {
  id: string
  index: number
  title: string
  tone: PlanTaskTone
  tasks: PlanTaskView[]
}

export type PlanSnapshot = {
  steps: PlanStepView[]
  tasks: PlanTaskView[]
  totalAgents: number
  runningAgents: number
  doneAgents: number
  failedAgents: number
  totalSteps: number
  currentStepID: string
  currentStep: number
  completedSteps: number
}

const statusPresentation: Record<PlanTask["status"], { tone: PlanTaskTone; label: string }> = {
  pending: { tone: "queued", label: "待处理" },
  dispatched: { tone: "queued", label: "已派发" },
  running: { tone: "running", label: "执行中" },
  reported: { tone: "review", label: "已提交" },
  approved: { tone: "done", label: "已通过" },
  rejected: { tone: "failed", label: "已拒绝" },
  dismissed: { tone: "failed", label: "已忽略" },
}

function numeric(value: number | string): number {
  if (typeof value === "number") return value
  const parsed = Number.parseFloat(value)
  return Number.isNaN(parsed) ? 0 : parsed
}

export function emptyPlanSnapshot(): PlanSnapshot {
  return {
    steps: [],
    tasks: [],
    totalAgents: 0,
    runningAgents: 0,
    doneAgents: 0,
    failedAgents: 0,
    totalSteps: 0,
    currentStepID: "",
    currentStep: 0,
    completedSteps: 0,
  }
}

export function projectPlanState(state: SessionPlanResponse): PlanSnapshot {
  if ("plan" in state) return emptyPlanSnapshot()
  const steps = state.steps.map((step, stepIndex): PlanStepView => {
    const index = Number(step.id.replace(/^s/, "")) || stepIndex + 1
    const tasks = step.tasks.map((item): PlanTaskView => {
      const presentation = statusPresentation[item.status]
      return {
        key: item.id,
        id: item.id,
        step: index,
        title: item.title,
        status: item.status,
        tone: presentation.tone,
        statusLabel: presentation.label,
        ...(item.child ? { childSessionID: item.child.session_id } : {}),
      }
    })
    const tone: PlanTaskTone =
      step.status === "done"
        ? "done"
        : tasks.some((task) => task.tone === "running")
          ? "running"
          : tasks.some((task) => task.tone === "review")
            ? "review"
            : tasks.some((task) => task.tone === "failed")
              ? "failed"
              : step.status === "active"
                ? "running"
                : "queued"
    return { id: step.id, index, title: step.title, tone, tasks }
  })
  const tasks = steps.flatMap((step) => step.tasks)
  const currentStepID = state.current_step ?? ""
  const currentStep = currentStepID
    ? Number(currentStepID.replace(/^s/, "")) || steps.find((step) => step.id === currentStepID)?.index || 0
    : 0
  return {
    steps,
    tasks,
    totalAgents: tasks.length,
    runningAgents: tasks.filter((task) => task.tone === "running" || task.tone === "review").length,
    doneAgents: tasks.filter((task) => task.tone === "done").length,
    failedAgents: tasks.filter((task) => task.tone === "failed").length,
    totalSteps: steps.length,
    currentStepID,
    currentStep,
    completedSteps: steps.filter((step) => step.tone === "done").length,
  }
}

// ---------- 视图 ----------

function toneSymbol(tone: PlanTaskTone): string {
  switch (tone) {
    case "running":
      return "▶"
    case "review":
      return "◔"
    case "done":
      return "✓"
    case "failed":
      return "✕"
    default:
      return "○"
  }
}

function toneColor(tone: PlanTaskTone, theme: ReturnType<typeof useTheme>["theme"]): RGBA {
  switch (tone) {
    case "running":
      return theme.primary
    case "review":
      return theme.warning
    case "done":
      return theme.success
    case "failed":
      return theme.error
    default:
      return theme.textMuted
  }
}

function PlanPanelView(props: { api: TuiPluginApi; sessionID: string }) {
  const dimensions = useTerminalDimensions()
  const { theme } = useTheme()
  const [refresh, setRefresh] = createSignal(0)
  const [data] = createResource([() => props.sessionID, refresh], async () => {
    const result = await props.api.client.session.plan({ sessionID: props.sessionID }).catch(() => undefined)
    return projectPlanState(result?.data ?? { plan: null })
  })
  const snapshot = () => data() ?? emptyPlanSnapshot()

  const off = props.api.event.on("plan.runtime.event", (event) => {
    if (event.properties.session_id === props.sessionID && event.properties.type === "plan.updated") {
      setRefresh((x) => x + 1)
    }
  })
  onCleanup(off)

  return (
    <box width={dimensions().width} height={dimensions().height} backgroundColor={theme.background} flexDirection="column">
      <box paddingLeft={2} paddingRight={2} paddingTop={1} paddingBottom={1} flexShrink={0}>
        <text fg={theme.text}>
          <b>Plan</b>
        </text>
        <text fg={theme.textMuted}>
          {"  "}步骤 {snapshot().completedSteps}/{snapshot().totalSteps} · 子任务 {snapshot().doneAgents}/{snapshot().totalAgents}
          {snapshot().runningAgents > 0 ? ` · 执行中 ${snapshot().runningAgents}` : ""}
        </text>
      </box>
      <Show when={data.loading}>
        <box paddingLeft={2} paddingTop={1}>
          <text fg={theme.textMuted}>加载中…</text>
        </box>
      </Show>
      <Show when={!data.loading}>
        <scrollbox flexGrow={1} minHeight={0} paddingLeft={2} paddingRight={2}>
          <Show when={snapshot().totalSteps === 0} fallback={<></>}>
            <box paddingTop={2}>
              <text fg={theme.textMuted}>当前会话没有进行中的 Plan（多智能体模式会生成）。</text>
            </box>
          </Show>
          <For each={snapshot().steps}>
            {(step) => (
              <box flexDirection="column" paddingTop={1} paddingBottom={1}>
                <box flexDirection="row" gap={1}>
                  <text fg={toneColor(step.tone, theme)}>
                    {toneSymbol(step.tone)} S{step.index}
                  </text>
                  <text fg={theme.text} flexGrow={1}>
                    {step.title}
                  </text>
                </box>
                <For each={step.tasks}>
                  {(task) => (
                    <box flexDirection="row" gap={1} paddingLeft={4}>
                      <text fg={toneColor(task.tone, theme)} width={2}>
                        {toneSymbol(task.tone)}
                      </text>
                      <text fg={theme.textMuted} flexGrow={1}>
                        {task.title}
                      </text>
                      <text fg={toneColor(task.tone, theme)}>{task.statusLabel}</text>
                    </box>
                  )}
                </For>
              </box>
            )}
          </For>
        </scrollbox>
      </Show>
      <box flexShrink={0} paddingLeft={2} paddingRight={2} paddingBottom={1}>
        <text fg={theme.textMuted}>Esc 关闭</text>
      </box>
    </box>
  )
}

const tui: TuiPlugin = async (api) => {
  api.route.register([
    {
      name: ROUTE,
      render: (input) => (
        <PlanPanelView api={api} sessionID={String((input.params as { sessionID?: unknown })?.sessionID ?? "")} />
      ),
    },
  ])

  api.keymap.registerLayer({
    commands: [
      {
        name: "plan.show",
        title: "Plan 面板",
        slashName: "plan",
        category: "Session",
        namespace: "palette",
        enabled: () => api.route.current.name === "session",
        run() {
          const current = api.route.current
          if (current.name !== "session") return
          const sessionID = String(current.params?.sessionID ?? "")
          if (!sessionID) return
          api.ui.dialog.clear()
          api.route.navigate(ROUTE, { sessionID })
        },
      },
    ],
  })
}

export default {
  id: "plan-panel",
  tui,
}
