import type { SessionAgentClusterResponse } from "@jyycode-ai/sdk/v2/client"
import { tr } from "../../i18n/i18n-context"
import { roleCapability } from "./role-capabilities"
import type { AgentClusterState } from "./multi-agent-query"

type ClusterRun = SessionAgentClusterResponse["runs"][number]
type ClusterTask = SessionAgentClusterResponse["tasks"][number]

export type MultiAgentTaskTone = "queued" | "running" | "review" | "done" | "failed"

export type MultiAgentTaskView = {
  key: string
  id: string
  runID: string
  step: number
  localStep: number
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
}

export type MultiAgentRunView = {
  id: string
  status: ClusterRun["status"]
  statusLabel: string
  goal: string
  timeCreated: number
  timeUpdated: number
}

export type MultiAgentStepView = {
  index: number
  runID: string
  localStep: number
  tone: MultiAgentTaskTone
  tasks: MultiAgentTaskView[]
}

export type MultiAgentSnapshot = {
  runs: MultiAgentRunView[]
  steps: MultiAgentStepView[]
  tasks: MultiAgentTaskView[]
  latestRun?: MultiAgentRunView
  latestGoal?: string
  totalAgents: number
  runningAgents: number
  doneAgents: number
  failedAgents: number
  totalSteps: number
  currentStep: number
  completedSteps: number
}

const runStatusLabelKeys = {
  planning: "multi-agent.run-status-planning",
  dispatching: "multi-agent.run-status-dispatching",
  reviewing: "multi-agent.run-status-reviewing",
  synthesizing: "multi-agent.run-status-synthesizing",
  completed: "multi-agent.run-status-completed",
  failed: "multi-agent.run-status-failed",
  cancelled: "multi-agent.run-status-cancelled",
} as const satisfies Record<ClusterRun["status"], Parameters<typeof tr>[0]>

const taskStatusPresentation: Record<ClusterTask["status"], { tone: MultiAgentTaskTone; labelKey: Parameters<typeof tr>[0] }> = {
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
}

function numeric(value: number | string) {
  const result = Number(value)
  return Number.isFinite(result) ? result : 0
}

function byTimeAndID<T extends { id: string; time_created: number | string }>(left: T, right: T) {
  return numeric(left.time_created) - numeric(right.time_created) || left.id.localeCompare(right.id)
}

function stepTone(tasks: MultiAgentTaskView[]): MultiAgentTaskTone {
  if (tasks.some((task) => task.tone === "failed")) return "failed"
  if (tasks.some((task) => task.tone === "running")) return "running"
  if (tasks.some((task) => task.tone === "review")) return "review"
  if (tasks.length > 0 && tasks.every((task) => task.tone === "done")) return "done"
  return "queued"
}

export function projectAgentClusterState(state: AgentClusterState): MultiAgentSnapshot {
  const orderedRuns = [...state.runs].sort(byTimeAndID)
  const runs: MultiAgentRunView[] = orderedRuns.map((item) => ({
    id: item.id,
    status: item.status,
    statusLabel: tr(runStatusLabelKeys[item.status]),
    goal: item.goal,
    timeCreated: numeric(item.time_created),
    timeUpdated: numeric(item.time_updated),
  }))
  const latestRun = runs.at(-1)

  const runOrder = new Map(orderedRuns.map((item, index) => [item.id, index]))
  const taskIDCounts = new Map<string, number>()
  for (const item of state.tasks) taskIDCounts.set(item.id, (taskIDCounts.get(item.id) ?? 0) + 1)
  const qualifyTaskID = (runID: string, taskID: string) =>
    (taskIDCounts.get(taskID) ?? 0) > 1 ? `${runID}:${taskID}` : taskID

  const orderedTasks = [...state.tasks].sort(
    (left, right) =>
      (runOrder.get(left.run_id) ?? Number.MAX_SAFE_INTEGER) -
        (runOrder.get(right.run_id) ?? Number.MAX_SAFE_INTEGER) ||
      left.run_id.localeCompare(right.run_id) ||
      numeric(left.step) - numeric(right.step) ||
      byTimeAndID(left, right),
  )

  const grouped = new Map<string, { runID: string; localStep: number; rows: ClusterTask[] }>()
  for (const item of orderedTasks) {
    const localStep = numeric(item.step)
    const groupKey = `${item.run_id}\u0000${localStep}`
    const group = grouped.get(groupKey) ?? { runID: item.run_id, localStep, rows: [] }
    group.rows.push(item)
    grouped.set(groupKey, group)
  }

  const tasks: MultiAgentTaskView[] = []
  const steps: MultiAgentStepView[] = []
  let globalStep = 0
  for (const group of grouped.values()) {
    globalStep += 1
    const stepTasks = group.rows.map((item): MultiAgentTaskView => {
      const presentation = taskStatusPresentation[item.status]
      const view: MultiAgentTaskView = {
        key: qualifyTaskID(item.run_id, item.id),
        id: item.id,
        runID: item.run_id,
        step: globalStep,
        localStep: group.localStep,
        role: item.role,
        skillName: roleCapability(item.role).skill,
        skillNames: [...roleCapability(item.role).skills],
        capabilitySummary: roleCapability(item.role).summary,
        title: item.title,
        model: item.model,
        status: item.status,
        tone: presentation.tone,
        statusLabel: tr(presentation.labelKey),
        dependencies: item.dependencies.map((dependency) => qualifyTaskID(item.run_id, dependency)),
        acceptanceCriteria: [...item.acceptance_criteria],
        artifactPaths: [...item.artifact_paths],
        reviewIssues: [...item.review_issues],
        reviewRound: numeric(item.review_round),
      }
      if (item.child_session_id) view.childSessionID = item.child_session_id
      if (item.result_summary) view.resultSummary = item.result_summary
      if (item.last_event) view.lastEvent = item.last_event
      return view
    })
    tasks.push(...stepTasks)
    steps.push({
      index: globalStep,
      runID: group.runID,
      localStep: group.localStep,
      tone: stepTone(stepTasks),
      tasks: stepTasks,
    })
  }

  const activeStep = steps.find((step) => step.tasks.some((task) => task.tone === "running" || task.tone === "review"))
  const incompleteStep = steps.find((step) => step.tone !== "done")
  const completedSteps = steps.filter((step) => step.tone === "done").length

  return {
    runs,
    steps,
    tasks,
    latestRun,
    latestGoal: latestRun?.goal || undefined,
    totalAgents: tasks.length,
    runningAgents: tasks.filter((task) => task.tone === "running" || task.tone === "review").length,
    doneAgents: tasks.filter((task) => task.tone === "done").length,
    failedAgents: tasks.filter((task) => task.tone === "failed").length,
    totalSteps: steps.length,
    currentStep: activeStep?.index ?? incompleteStep?.index ?? steps.length,
    completedSteps,
  }
}

export function findTaskByChildSessionID(snapshot: MultiAgentSnapshot, childSessionID: string | undefined) {
  if (!childSessionID) return undefined
  return snapshot.tasks.find((task) => task.childSessionID === childSessionID)
}
