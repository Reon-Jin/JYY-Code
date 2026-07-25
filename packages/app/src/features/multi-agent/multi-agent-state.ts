import type { SessionAgentClusterResponse } from "@jyycode-ai/sdk/v2/client"
import { tr } from "../../i18n/i18n-context"
import { roleCapability } from "./role-capabilities"

type ClusterTask = SessionAgentClusterResponse["tasks"][number]

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
  status: ClusterTask["status"]
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

const taskStatusPresentation: Record<
  ClusterTask["status"],
  { tone: MultiAgentTaskTone; labelKey: Parameters<typeof tr>[0] }
> = {
  planned: { tone: "queued", labelKey: "multi-agent.task-status-planned" },
  queued: { tone: "queued", labelKey: "multi-agent.task-status-queued" },
  running: { tone: "running", labelKey: "multi-agent.task-status-running" },
  revising: { tone: "running", labelKey: "multi-agent.task-status-revising" },
  submitted: { tone: "review", labelKey: "multi-agent.task-status-submitted" },
  reviewing: { tone: "review", labelKey: "multi-agent.task-status-reviewing" },
  revision_requested: { tone: "review", labelKey: "multi-agent.task-status-revision-requested" },
  accepted: { tone: "done", labelKey: "multi-agent.task-status-accepted" },
  failed: { tone: "failed", labelKey: "multi-agent.task-status-failed" },
  cancelled: { tone: "failed", labelKey: "multi-agent.task-status-cancelled" },
  interrupted: { tone: "interrupted", labelKey: "multi-agent.task-status-interrupted" },
}

function numeric(value: number | string) {
  return Number(value) || 0
}
function stepTone(tasks: MultiAgentTaskView[]): MultiAgentTaskTone {
  if (tasks.some((task) => task.tone === "running")) return "running"
  if (tasks.some((task) => task.tone === "review")) return "review"
  if (tasks.some((task) => task.tone === "interrupted")) return "interrupted"
  if (tasks.some((task) => task.tone === "failed")) return "failed"
  if (tasks.length > 0 && tasks.every((task) => task.tone === "done")) return "done"
  return "queued"
}

export function projectAgentClusterState(state: SessionAgentClusterResponse): MultiAgentSnapshot {
  const ordered = [...state.tasks].sort(
    (a, b) =>
      numeric(a.step) - numeric(b.step) ||
      numeric(a.time_created) - numeric(b.time_created) ||
      a.id.localeCompare(b.id),
  )
  const tasks = ordered.map((item): MultiAgentTaskView => {
    const presentation = taskStatusPresentation[item.status]
    return {
      key: item.id,
      id: item.id,
      step: numeric(item.step),
      role: item.role,
      skillName: roleCapability(item.role).skill,
      skillNames: [...roleCapability(item.role).skills],
      capabilitySummary: roleCapability(item.role).summary,
      title: item.title,
      model: item.model,
      status: item.status,
      tone: presentation.tone,
      statusLabel: tr(presentation.labelKey),
      ...(item.child_session_id ? { childSessionID: item.child_session_id } : {}),
      dependencies: [...item.dependencies],
      acceptanceCriteria: [...item.acceptance_criteria],
      artifactPaths: [...item.artifact_paths],
      ...(item.result_summary ? { resultSummary: item.result_summary } : {}),
      reviewIssues: [...item.review_issues],
      ...(item.last_event ? { lastEvent: item.last_event } : {}),
      reviewRound: numeric(item.review_round),
      elapsedMs: Math.max(0, Date.now() - numeric(item.time_created)),
    }
  })
  const grouped = new Map<number, MultiAgentTaskView[]>()
  for (const task of tasks) grouped.set(task.step, [...(grouped.get(task.step) ?? []), task])
  const steps = [...grouped.entries()].map(([index, waveTasks]) => {
    const tone = stepTone(waveTasks)
    return { index, tone, collapsed: tone === "done", tasks: waveTasks }
  })
  const current =
    steps.find((step) => step.tone === "running" || step.tone === "review") ??
    steps.find((step) => step.tone === "queued")
  return {
    steps,
    tasks,
    totalAgents: tasks.length,
    runningAgents: tasks.filter((t) => t.tone === "running" || t.tone === "review").length,
    doneAgents: tasks.filter((t) => t.tone === "done").length,
    failedAgents: tasks.filter((t) => t.tone === "failed").length,
    interruptedAgents: tasks.filter((t) => t.tone === "interrupted").length,
    totalSteps: steps.length,
    currentStep: current?.index ?? steps.at(-1)?.index ?? 0,
    completedSteps: steps.filter((step) => step.tone === "done").length,
  }
}

export function findTaskByChildSessionID(snapshot: MultiAgentSnapshot, childSessionID: string | undefined) {
  return childSessionID ? snapshot.tasks.find((task) => task.childSessionID === childSessionID) : undefined
}
