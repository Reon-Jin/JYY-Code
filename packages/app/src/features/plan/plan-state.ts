import type { SessionPlanResponse } from "@jyycode-ai/sdk/v2/client"
import { tr } from "../../i18n/i18n-context"
import { roleCapability } from "../multi-agent/role-capabilities"

type PlanData = Exclude<SessionPlanResponse, { plan: null }>
type PlanTask = PlanData["steps"][number]["tasks"][number]

export type MultiAgentTaskTone = "queued" | "running" | "review" | "done" | "failed" | "interrupted"

export type MultiAgentTaskView = {
  key: string
  id: string
  step: number
  role: string
  skillName: string
  skillNames: string[]
  capabilitySummary: string
  title: string
  model: string
  status: PlanTask["status"]
  tone: MultiAgentTaskTone
  statusLabel: string
  childSessionID?: string
  dependencies: string[]
  acceptanceCriteria: string[]
  artifactPaths: string[]
  resultSummary?: string
  reviewIssues: string[]
  lastEvent?: string
  reviewRound: number
  elapsedMs: number
}

export type MultiAgentStepView = {
  index: number
  title: string
  tone: MultiAgentTaskTone
  collapsed: boolean
  tasks: MultiAgentTaskView[]
}

export type MultiAgentSnapshot = {
  steps: MultiAgentStepView[]
  tasks: MultiAgentTaskView[]
  totalAgents: number
  runningAgents: number
  doneAgents: number
  failedAgents: number
  interruptedAgents: number
  totalSteps: number
  currentStep: number
  completedSteps: number
}

const statusPresentation: Record<
  PlanTask["status"],
  { tone: MultiAgentTaskTone; labelKey: Parameters<typeof tr>[0] }
> = {
  pending: { tone: "queued", labelKey: "multi-agent.task-status-planned" },
  dispatched: { tone: "queued", labelKey: "multi-agent.task-status-queued" },
  running: { tone: "running", labelKey: "multi-agent.task-status-running" },
  reported: { tone: "review", labelKey: "multi-agent.task-status-submitted" },
  approved: { tone: "done", labelKey: "multi-agent.task-status-accepted" },
  rejected: { tone: "failed", labelKey: "multi-agent.task-status-revision-requested" },
}

function numeric(value: number | string) {
  return Number(value) || 0
}

function emptySnapshot(): MultiAgentSnapshot {
  return {
    steps: [],
    tasks: [],
    totalAgents: 0,
    runningAgents: 0,
    doneAgents: 0,
    failedAgents: 0,
    interruptedAgents: 0,
    totalSteps: 0,
    currentStep: 0,
    completedSteps: 0,
  }
}

export function projectPlanState(state: SessionPlanResponse): MultiAgentSnapshot {
  if ("plan" in state) return emptySnapshot()
  const capability = roleCapability("general")
  const steps = state.steps.map((step, stepIndex): MultiAgentStepView => {
    const index = Number(step.id.replace(/^s/, "")) || stepIndex + 1
    const tasks = step.tasks.map((item): MultiAgentTaskView => {
      const presentation = statusPresentation[item.status]
      return {
        key: item.id,
        id: item.id,
        step: index,
        role: "general",
        skillName: capability.skill,
        skillNames: [...capability.skills],
        capabilitySummary: capability.summary,
        title: item.title,
        model: "",
        status: item.status,
        tone: presentation.tone,
        statusLabel: tr(presentation.labelKey),
        ...(item.child ? { childSessionID: item.child.session_id } : {}),
        dependencies: [],
        acceptanceCriteria: [],
        artifactPaths: [],
        reviewIssues: [],
        ...(item.child?.last_activity ? { lastEvent: item.child.last_activity } : {}),
        reviewRound: 0,
        elapsedMs: item.child ? numeric(item.child.elapsed_sec) * 1000 : 0,
      }
    })
    const tone: MultiAgentTaskTone =
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
    return { index, title: step.title, tone, collapsed: tone === "done", tasks }
  })
  const tasks = steps.flatMap((step) => step.tasks)
  const currentStep = state.current_step
    ? Number(state.current_step.replace(/^s/, "")) || steps.find((step) => step.tone !== "done")?.index || 0
    : steps.at(-1)?.index ?? 0
  return {
    steps,
    tasks,
    totalAgents: tasks.length,
    runningAgents: tasks.filter((task) => task.tone === "running" || task.tone === "review").length,
    doneAgents: tasks.filter((task) => task.tone === "done").length,
    failedAgents: tasks.filter((task) => task.tone === "failed").length,
    interruptedAgents: 0,
    totalSteps: steps.length,
    currentStep,
    completedSteps: steps.filter((step) => step.tone === "done").length,
  }
}

export function findTaskByChildSessionID(snapshot: MultiAgentSnapshot, childSessionID: string | undefined) {
  return childSessionID ? snapshot.tasks.find((task) => task.childSessionID === childSessionID) : undefined
}
