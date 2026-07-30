import type { Session, SessionStatus } from "@jyycode-ai/sdk/v2/client"
import {
  Bot,
  Boxes,
  Braces,
  CheckCircle2,
  CircleDot,
  ClipboardList,
  FileCheck2,
  GitCompareArrows,
  GitPullRequest,
  History,
  LayoutDashboard,
  ListTree,
  MessageSquare,
  Network,
  PanelsTopLeft,
  PenLine,
  Radio,
  RefreshCw,
  Save,
  ShieldAlert,
  UsersRound,
  X,
} from "lucide-solid"
import { createMemo, createSignal, For, Show, type JSX } from "solid-js"
import { Button } from "../../components/ui/button"
import { tr } from "../../i18n/i18n-context"
import type { ConversationSnapshot } from "../conversation/conversation-state"
import { MessageTimeline } from "../conversation/message-timeline"
import { displaySessionTitle } from "../sessions/session-title"
import type {
  SessionArtifact,
  SessionAssignment,
  SessionBlackboardCard,
  SessionBlackboardDraft,
  SessionReviewFinding,
  SessionRunPlan,
  SessionRunPlanPatch,
  SessionRunPlanVersion,
  SessionWorkflowEvent,
} from "./workflow-query"

type WorkspaceTab = "overview" | "plan" | "agents" | "blackboard" | "review" | "deliverables" | "diff"
type WorkspaceStatus = "running" | "attention" | "ready"
type BuiltinWorkflowID = "general" | "workflow-creation"
type AgentFlowNode = { id: string; name: string; role: string; status: string; task: string; detail: string }

const copy = {
  overview: "\u6982\u89c8",
  plan: "\u65b9\u6848",
  agents: "\u667a\u80fd\u4f53",
  blackboard: "\u9ed1\u677f",
  review: "\u5ba1\u6838",
  deliverables: "\u4ea4\u4ed8\u7269",
  diff: "\u5dee\u5f02",
  chat: "\u5bf9\u8bdd",
  generalWorkflow: "\u901a\u7528\u5de5\u4f5c\u6d41",
  workflowCreation: "\u521b\u5efa\u5de5\u4f5c\u6d41",
  workflowCreationNote: "\u7528\u4e8e\u4ece\u9700\u6c42\u3001\u9a8c\u8bc1\u5230\u5b89\u88c5\u5730\u751f\u6210\u4e00\u4e2a\u65b0\u5de5\u4f5c\u6d41\u3002",
  workflowGeneralNote: "\u9002\u5408\u6ca1\u6709\u7279\u6b8a\u6a21\u677f\u8981\u6c42\u7684\u65e5\u5e38\u5de5\u7a0b\u4efb\u52a1\u3002",
  workflow: "\u5de5\u4f5c\u6d41",
  switchWorkflow: "\u5207\u6362\u5de5\u4f5c\u6d41",
  selectingWorkflow: "\u6b63\u5728\u5207\u6362\u2026",
  modeSingle: "\u5355\u667a\u80fd\u4f53",
  modeMulti: "\u591a\u667a\u80fd\u4f53",
  currentStatus: "\u5f53\u524d\u72b6\u6001",
  activeAgents: "\u6d3b\u8dc3\u667a\u80fd\u4f53",
  attention: "\u5f85\u5173\u6ce8",
  nextStep: "\u4e0b\u4e00\u6b65",
  latestArtifacts: "\u6700\u8fd1\u5171\u4eab\u4ea4\u4ed8\u7269",
  noPlan: "\u5c1a\u672a\u751f\u6210\u53ef\u6267\u884c\u65b9\u6848\u3002",
  noArtifacts: "\u8fd8\u6ca1\u6709\u53d1\u5e03\u5171\u4eab\u4ea4\u4ed8\u7269\u3002",
  noAttention: "\u6682\u65e0\u9700\u8981\u5904\u7406\u7684\u4e8b\u9879\u3002",
  noPending: "\u5f53\u524d\u65b9\u6848\u6ca1\u6709\u5f85\u6267\u884c\u4efb\u52a1\u3002",
  editPlan: "\u7f16\u8f91\u65b9\u6848",
  editSource: "\u7f16\u8f91\u65b9\u6848\u6e90\u7801",
  save: "\u4fdd\u5b58",
  saving: "\u6b63\u5728\u4fdd\u5b58\u2026",
  cancel: "\u53d6\u6d88",
  task: "\u4efb\u52a1",
  taskName: "\u4efb\u52a1\u540d\u79f0",
  dependencies: "\u4f9d\u8d56\u4efb\u52a1",
  selectTask: "\u9009\u62e9\u8981\u7f16\u8f91\u7684\u4efb\u52a1",
  searchTasks: "\u641c\u7d22\u4efb\u52a1",
  allStatuses: "\u5168\u90e8\u72b6\u6001",
  hideAccepted: "\u9690\u85cf\u5df2\u9a8c\u6536",
  dependencyGraph: "\u4f9d\u8d56\u5173\u7cfb",
  planSource: "\u65b9\u6848\u6e90\u7801",
  versionHistory: "\u7248\u672c\u8bb0\u5f55",
  restore: "\u6062\u590d",
  agentFlow: "\u667a\u80fd\u4f53\u534f\u4f5c\u56fe",
  agentFlowNote: "\u70b9\u51fb\u8282\u70b9\u67e5\u770b\u5206\u5de5\u548c\u5f53\u524d\u8fdb\u5ea6\u3002",
  mainAgent: "\u4e3b\u667a\u80fd\u4f53",
  noAgents: "\u5f53\u524d\u8fd8\u6ca1\u6709\u5206\u914d\u667a\u80fd\u4f53\u3002",
  selectedAgent: "\u5df2\u9009\u667a\u80fd\u4f53",
  blackboardNote: "\u5728\u6b64\u6c89\u6dc0\u51b3\u7b56\u3001\u7ea6\u675f\u3001\u8bc1\u636e\u548c\u98ce\u9669\u3002",
  reviewNote: "\u6bcf\u4e00\u6761\u95ee\u9898\u90fd\u4fdd\u7559\u8bc1\u636e\u4e0e\u5904\u7406\u5efa\u8bae\u3002",
  deliverablesNote: "\u6b64\u5904\u96c6\u4e2d\u67e5\u770b\u53ef\u8ffd\u6eaf\u7684\u6700\u7ec8\u6210\u679c\u3002",
  diffNote: "\u6bd4\u8f83\u5f53\u524d\u65b9\u6848\u4e0e\u5386\u53f2\u7248\u672c\u7684\u53d8\u66f4\u3002",
  noDiff: "\u5c1a\u65e0\u53ef\u6bd4\u8f83\u7684\u5386\u53f2\u7248\u672c\u3002",
  chatNote: "\u4e0e\u4e3b\u667a\u80fd\u4f53\u5bf9\u8bdd\uff0c\u65b9\u6848\u53d8\u66f4\u4f1a\u540c\u6b65\u53cd\u6620\u5728\u5de5\u4f5c\u53f0\u3002",
  ready: "\u5c31\u7eea",
  running: "\u8fd0\u884c\u4e2d",
  attentionStatus: "\u9700\u8981\u5173\u6ce8",
  waiting: "\u7b49\u5f85\u4e2d",
  planned: "\u5df2\u89c4\u5212",
  accepted: "\u5df2\u9a8c\u6536",
  failed: "\u5931\u8d25",
  reviewing: "\u5ba1\u6838\u4e2d",
  submitted: "\u5df2\u63d0\u4ea4",
  blocked: "\u5df2\u963b\u585e",
  noWorkflowChange: "\u6682\u65e0\u53ef\u7528\u7684\u5de5\u4f5c\u6d41\u5207\u6362\u64cd\u4f5c\u3002",
  expand: "\u70b9\u51fb\u5c55\u5f00",
  close: "\u6536\u8d77",
  controls: "\u4efb\u52a1\u63a7\u5236\u4e0e\u8f93\u5165",
  controlsNote: "\u5728\u6b64\u5207\u6362\u667a\u80fd\u4f53\u3001\u6a21\u578b\u4e0e\u5de5\u5177\uff0c\u5e76\u53d1\u9001\u6d88\u606f\u3002",
  publish: "\u53d1\u5e03\u5230\u9ed1\u677f",
  publishing: "\u6b63\u5728\u53d1\u5e03\u2026",
  blackboardTitle: "\u4fe1\u606f\u6807\u9898",
  blackboardSummary: "\u53d1\u5e03\u5185\u5bb9",
  blackboardAuthor: "\u53d1\u5e03\u667a\u80fd\u4f53",
} as const

const tabs: ReadonlyArray<{ id: WorkspaceTab; label: Parameters<typeof tr>[0]; icon: typeof LayoutDashboard }> = [
  { id: "overview", label: "session-workspace.overview", icon: LayoutDashboard },
  { id: "plan", label: "session-workspace.plan", icon: ClipboardList },
  { id: "agents", label: "session-workspace.agents", icon: Bot },
  { id: "blackboard", label: "session-workspace.blackboard", icon: Boxes },
  { id: "review", label: "session-workspace.review", icon: GitPullRequest },
  { id: "deliverables", label: "session-workspace.deliverables", icon: FileCheck2 },
  { id: "diff", label: "session-workspace.diff", icon: GitCompareArrows },
]

const workflowOptions: ReadonlyArray<{ id: BuiltinWorkflowID; version: string; label: string; description: string }> = [
  { id: "general", version: "2.0.0", label: copy.generalWorkflow, description: copy.workflowGeneralNote },
  { id: "workflow-creation", version: "2.0.0", label: copy.workflowCreation, description: copy.workflowCreationNote },
]

function workspaceStatusLabel(status: WorkspaceStatus | undefined) {
  switch (status) {
    case "running":
      return tr("session-workspace.running")
    case "attention":
      return tr("session-workspace.attention")
    default:
      return tr("session-workspace.ready")
  }
}

function taskStatusLabel(status: string | undefined) {
  switch (status) {
    case "running":
    case "revising":
    case "checkpointed":
      return copy.running
    case "accepted":
    case "completed":
      return copy.accepted
    case "failed":
    case "failed_with_report":
      return copy.failed
    case "blocked":
      return copy.blocked
    case "reviewing":
      return copy.reviewing
    case "submitted":
      return copy.submitted
    case "planned":
    case "assigned":
    case "ready":
      return copy.planned
    default:
      return copy.waiting
  }
}

function blackboardTypeLabel(type: SessionBlackboardDraft["type"]) {
  switch (type) {
    case "decision": return "决策"
    case "contract": return "约定"
    case "constraint": return "约束"
    case "evidence": return "证据"
    case "risk": return "风险"
    case "blocker": return "阻塞"
    default: return "提案"
  }
}

export function SessionWorkspace(props: {
  session: Session
  status?: SessionStatus
  multiAgentEnabled?: boolean
  runPlan?: SessionRunPlan
  planVersions?: readonly SessionRunPlanVersion[]
  artifacts?: readonly SessionArtifact[]
  blackboard?: readonly SessionBlackboardCard[]
  reviews?: readonly SessionReviewFinding[]
  assignments?: readonly SessionAssignment[]
  events?: readonly SessionWorkflowEvent[]
  conversation?: ConversationSnapshot
  conversationLoading?: boolean
  conversationError?: string
  planStatus?: "planning" | "ready"
  onPatchRunPlan?: (patch: SessionRunPlanPatch) => Promise<void>
  onRestoreRunPlanVersion?: (version: number) => Promise<void>
  onSetPlanMode?: (mode: "single" | "multi") => Promise<void>
  onSelectWorkflow?: (workflowID: BuiltinWorkflowID, workflowVersion: string) => Promise<void>
  onPublishBlackboard?: (card: SessionBlackboardDraft) => Promise<void>
  onRetryConversation?: () => void
  requestArea?: JSX.Element
  commandBar?: JSX.Element
  composer?: JSX.Element
  context?: JSX.Element
}) {
  const [activeTab, setActiveTab] = createSignal<WorkspaceTab>("overview")
  const [expandedTab, setExpandedTab] = createSignal<WorkspaceTab>()
  const [dockTab, setDockTab] = createSignal<"chat" | "collaboration" | "events">("chat")
  const active = createMemo(() => tabs.find((tab) => tab.id === activeTab())!)
  const planTasks = createMemo(() => props.runPlan?.tasks ?? [])
  const status = createMemo<WorkspaceStatus>(() => {
    if (props.status?.type === "busy" || props.status?.type === "retry") return "running"
    return planTasks().some((task) => task.status === "failed" || task.status === "blocked") ? "attention" : "ready"
  })
  const [planSearch, setPlanSearch] = createSignal("")
  const [planStatusFilter, setPlanStatusFilter] = createSignal("all")
  const [hideCompleted, setHideCompleted] = createSignal(false)
  const visiblePlanTasks = createMemo(() => {
    const query = planSearch().trim().toLowerCase()
    return planTasks().filter((task) => {
      if (hideCompleted() && task.status === "accepted") return false
      if (planStatusFilter() !== "all" && task.status !== planStatusFilter()) return false
      return !query || `${task.title} ${task.id} ${task.stageID} ${task.assignee ?? ""}`.toLowerCase().includes(query)
    })
  })
  const acceptedPlanTasks = createMemo(() => planTasks().filter((task) => task.status === "accepted").length)
  const runningPlanTasks = createMemo(() => planTasks().filter((task) => task.status === "running" || task.status === "revising"))
  const attention = createMemo(() => planTasks().filter((task) => task.status === "failed" || task.status === "blocked" || task.status === "revision_requested"))
  const nextStep = createMemo(() => attention()[0] ?? planTasks().find((task) => task.status !== "accepted"))
  const [editingTaskID, setEditingTaskID] = createSignal<string>()
  const [draftTitle, setDraftTitle] = createSignal("")
  const [draftDependsOn, setDraftDependsOn] = createSignal("")
  const [patchError, setPatchError] = createSignal<string>()
  const [patching, setPatching] = createSignal(false)
  const editingTask = createMemo(() => planTasks().find((task) => task.id === editingTaskID()))
  const planYaml = createMemo(() => {
    const plan = props.runPlan
    if (!plan) return ""
    const lines = [`id: ${plan.id}`, `version: ${plan.version}`, `mode: ${plan.mode}`, `goal: ${plan.goal}`, "tasks:"]
    for (const task of plan.tasks) {
      lines.push(
        `  - id: ${task.id}`,
        `    title: ${JSON.stringify(task.title)}`,
        `    dependsOn: [${task.dependsOn.join(", ")}]`,
        `    status: ${task.status}`,
      )
    }
    return lines.join("\n")
  })
  const [yamlEditing, setYamlEditing] = createSignal(false)
  const [yamlDraft, setYamlDraft] = createSignal("")
  const [yamlError, setYamlError] = createSignal<string>()
  const [yamlSaving, setYamlSaving] = createSignal(false)
  const [pendingMode, setPendingMode] = createSignal<"single" | "multi">()
  const [modeSaving, setModeSaving] = createSignal(false)
  const [modeError, setModeError] = createSignal<string>()
  const [pendingRestoreVersion, setPendingRestoreVersion] = createSignal<number>()
  const [restoreSaving, setRestoreSaving] = createSignal(false)
  const [restoreError, setRestoreError] = createSignal<string>()
  const [workflowSaving, setWorkflowSaving] = createSignal(false)
  const [workflowError, setWorkflowError] = createSignal<string>()
  const [selectedAgentID, setSelectedAgentID] = createSignal<string>()
  const [blackboardType, setBlackboardType] = createSignal<SessionBlackboardDraft["type"]>("proposal")
  const [blackboardTitle, setBlackboardTitle] = createSignal("")
  const [blackboardSummary, setBlackboardSummary] = createSignal("")
  const [blackboardAuthor, setBlackboardAuthor] = createSignal("")
  const [blackboardPublishing, setBlackboardPublishing] = createSignal(false)
  const [blackboardError, setBlackboardError] = createSignal<string>()
  const selectedWorkflow = createMemo<BuiltinWorkflowID>(() =>
    props.runPlan?.workflowID === "workflow-creation" ? "workflow-creation" : "general",
  )
  const activeWorkflowOption = createMemo(
    () => workflowOptions.find((workflow) => workflow.id === selectedWorkflow()) ?? workflowOptions[0]!,
  )
  const agentNodes = createMemo<AgentFlowNode[]>(() => {
    const assignments = props.assignments ?? []
    if (assignments.length) {
      return assignments.map((assignment) => {
        const task = planTasks().find((candidate) => candidate.id === assignment.nodeID)
        return {
          id: assignment.id,
          name: assignment.agentID,
          role: assignment.role,
          status: assignment.status,
          task: task?.title ?? copy.waiting,
          detail: assignment.checkpoint ?? assignment.workspaceID,
        }
      })
    }
    return planTasks().map((task) => ({
      id: task.id,
      name: task.assignee ?? copy.mainAgent,
      role: task.role ?? copy.task,
      status: task.status,
      task: task.title,
      detail: task.acceptance.map((rule) => rule.title).join(" ") || copy.waiting,
    }))
  })
  const selectedAgentNode = createMemo(() =>
    agentNodes().find((agent) => agent.id === selectedAgentID()) ?? agentNodes()[0],
  )

  function modulePreview(tab: WorkspaceTab) {
    switch (tab) {
      case "overview": return planTasks().length ? `${acceptedPlanTasks()} / ${planTasks().length} \u5df2\u9a8c\u6536` : copy.noPlan
      case "plan": return planTasks().length ? `${planTasks().length} \u9879\u4efb\u52a1\uff0c\u7248\u672c v${props.runPlan?.version}` : copy.noPlan
      case "agents": return agentNodes().length ? `${agentNodes().length} \u4e2a\u667a\u80fd\u4f53\u53c2\u4e0e\u534f\u4f5c` : copy.noAgents
      case "blackboard": return props.blackboard?.length ? `${props.blackboard.length} \u6761\u5171\u4eab\u8bb0\u5f55` : copy.blackboardNote
      case "review": return props.reviews?.length ? `${props.reviews.length} \u9879\u5ba1\u6838\u7ed3\u679c` : copy.reviewNote
      case "deliverables": return props.artifacts?.length ? `${props.artifacts.length} \u4e2a\u4ea4\u4ed8\u7269` : copy.deliverablesNote
      case "diff": return props.planVersions?.length && props.planVersions.length > 1 ? `${props.planVersions.length - 1} \u4e2a\u5386\u53f2\u7248\u672c` : copy.noDiff
    }
  }

  function beginTaskEdit(task: SessionRunPlan["tasks"][number]) {
    setEditingTaskID(task.id)
    setDraftTitle(task.title)
    setDraftDependsOn(task.dependsOn.join(", "))
    setPatchError(undefined)
  }

  function cancelTaskEdit() {
    setEditingTaskID(undefined)
    setPatchError(undefined)
  }

  async function saveTaskEdit() {
    const task = editingTask()
    const plan = props.runPlan
    if (!task || !plan || !props.onPatchRunPlan) return
    const title = draftTitle().trim()
    const dependsOn = [...new Set(draftDependsOn().split(",").map((id) => id.trim()).filter(Boolean))]
    if (!title) {
      setPatchError("\u4efb\u52a1\u540d\u79f0\u4e0d\u80fd\u4e3a\u7a7a\u3002")
      return
    }
    if (dependsOn.includes(task.id)) {
      setPatchError("\u4efb\u52a1\u4e0d\u80fd\u4f9d\u8d56\u81ea\u8eab\u3002")
      return
    }
    setPatching(true)
    setPatchError(undefined)
    try {
      await props.onPatchRunPlan({
        baseVersion: plan.version,
        reason: `\u5728\u5de5\u4f5c\u53f0\u4e2d\u4fee\u6539\u4efb\u52a1 ${task.id}`,
        operations: [{ type: "update_task", taskID: task.id, title, dependsOn }],
      })
      setEditingTaskID(undefined)
    } catch (error) {
      setPatchError(error instanceof Error ? error.message : "\u65e0\u6cd5\u4fdd\u5b58\u6b64\u6b21\u65b9\u6848\u4fee\u6539\u3002")
    } finally {
      setPatching(false)
    }
  }

  function openYamlEditor() {
    setYamlDraft(planYaml())
    setYamlError(undefined)
    setYamlEditing(true)
  }

  function parseYamlPatch(): SessionRunPlanPatch | undefined {
    const plan = props.runPlan
    if (!plan) return undefined
    let mode = plan.mode
    let currentID: string | undefined
    const changes = new Map<string, { title?: string; dependsOn?: string[] }>()
    for (const rawLine of yamlDraft().split("\n")) {
      const line = rawLine.trim()
      if (!line || line === "tasks:") continue
      if (line.startsWith("mode:")) {
        const next = line.slice("mode:".length).trim()
        if (next !== "single" && next !== "multi") throw new Error("\u6a21\u5f0f\u53ea\u80fd\u662f single \u6216 multi\u3002")
        mode = next
        continue
      }
      if (line.startsWith("- id:")) {
        currentID = line.slice("- id:".length).trim()
        if (!plan.tasks.some((task) => task.id === currentID)) throw new Error(`\u672a\u77e5\u4efb\u52a1 ID\uff1a${currentID}`)
        continue
      }
      if (!currentID) continue
      if (line.startsWith("title:")) {
        const value = line.slice("title:".length).trim()
        let title = value
        try { title = JSON.parse(value) as string } catch { /* Plain YAML strings are supported too. */ }
        if (!title.trim()) throw new Error(`\u4efb\u52a1 ${currentID} \u7684\u540d\u79f0\u4e3a\u7a7a\u3002`)
        changes.set(currentID, { ...changes.get(currentID), title })
        continue
      }
      if (line.startsWith("dependsOn:")) {
        const value = line.slice("dependsOn:".length).trim()
        if (!value.startsWith("[") || !value.endsWith("]")) throw new Error(`\u4efb\u52a1 ${currentID} \u7684 dependsOn \u9700\u4f7f\u7528 [task-id, ...] \u683c\u5f0f\u3002`)
        const dependsOn = [...new Set(value.slice(1, -1).split(",").map((id) => id.trim()).filter(Boolean))]
        if (dependsOn.includes(currentID)) throw new Error(`\u4efb\u52a1 ${currentID} \u4e0d\u80fd\u4f9d\u8d56\u81ea\u8eab\u3002`)
        changes.set(currentID, { ...changes.get(currentID), dependsOn })
      }
    }
    const operations: SessionRunPlanPatch["operations"] = []
    if (mode !== plan.mode) operations.push({ type: "set_mode", mode })
    for (const task of plan.tasks) {
      const change = changes.get(task.id)
      if (!change) continue
      const titleChanged = change.title !== undefined && change.title !== task.title
      const dependsChanged = change.dependsOn !== undefined && change.dependsOn.join("\u0000") !== task.dependsOn.join("\u0000")
      if (titleChanged || dependsChanged) {
        operations.push({
          type: "update_task",
          taskID: task.id,
          ...(titleChanged ? { title: change.title } : {}),
          ...(dependsChanged ? { dependsOn: change.dependsOn } : {}),
        })
      }
    }
    if (!operations.length) throw new Error("\u672a\u53d1\u73b0\u53ef\u4fdd\u5b58\u7684\u65b9\u6848\u4fee\u6539\u3002")
    return { baseVersion: plan.version, reason: "\u5728\u5de5\u4f5c\u53f0\u4e2d\u4fee\u6539\u65b9\u6848 YAML", operations }
  }

  async function saveYamlEdit() {
    if (!props.onPatchRunPlan) return
    setYamlSaving(true)
    setYamlError(undefined)
    try {
      const patch = parseYamlPatch()
      if (!patch) return
      await props.onPatchRunPlan(patch)
      setYamlEditing(false)
    } catch (error) {
      setYamlError(error instanceof Error ? error.message : "\u65e0\u6cd5\u4fdd\u5b58 YAML \u65b9\u6848\u3002")
    } finally {
      setYamlSaving(false)
    }
  }

  async function confirmModeChange() {
    const mode = pendingMode()
    if (!mode || !props.onSetPlanMode) return
    setModeSaving(true)
    setModeError(undefined)
    try {
      await props.onSetPlanMode(mode)
      setPendingMode(undefined)
    } catch (error) {
      setModeError(error instanceof Error ? error.message : "\u65e0\u6cd5\u5207\u6362\u6267\u884c\u6a21\u5f0f\u3002")
    } finally {
      setModeSaving(false)
    }
  }

  async function restoreVersion() {
    const version = pendingRestoreVersion()
    if (version === undefined || !props.onRestoreRunPlanVersion) return
    setRestoreSaving(true)
    setRestoreError(undefined)
    try {
      await props.onRestoreRunPlanVersion(version)
      setPendingRestoreVersion(undefined)
    } catch (error) {
      setRestoreError(error instanceof Error ? error.message : "\u65e0\u6cd5\u6062\u590d\u6b64\u65b9\u6848\u7248\u672c\u3002")
    } finally {
      setRestoreSaving(false)
    }
  }

  async function selectWorkflow(workflow: (typeof workflowOptions)[number]) {
    if (workflow.id === selectedWorkflow()) return true
    if (!props.onSelectWorkflow) {
      setWorkflowError(copy.noWorkflowChange)
      return false
    }
    setWorkflowSaving(true)
    setWorkflowError(undefined)
    try {
      await props.onSelectWorkflow(workflow.id, workflow.version)
      return true
    } catch (error) {
      const status = (error as { status?: unknown; response?: { status?: unknown } } | undefined)?.status
        ?? (error as { response?: { status?: unknown } } | undefined)?.response?.status
      const message = error instanceof Error ? error.message : ""
      const isBadRequest = status === 400 || /\b400\b|bad request/i.test(message)
      setWorkflowError(isBadRequest
        ? "工作流切换未完成。当前安装的内置工作流目录正在修复；升级后可直接切换，已有执行中的方案仍会受到保护。"
        : message || copy.noWorkflowChange)
      return false
    } finally {
      setWorkflowSaving(false)
    }
  }

  async function publishBlackboard() {
    if (!props.onPublishBlackboard) return
    const title = blackboardTitle().trim()
    const summary = blackboardSummary().trim()
    if (!title || !summary) {
      setBlackboardError("请填写信息标题和发布内容。")
      return
    }
    setBlackboardPublishing(true)
    setBlackboardError(undefined)
    try {
      await props.onPublishBlackboard({
        type: blackboardType(),
        title,
        summary,
        authorAgentID: blackboardAuthor() || selectedAgentNode()?.name || copy.mainAgent,
        relatedTasks: [],
        replaces: [],
        impactScope: "medium",
        artifacts: [],
      })
      setBlackboardTitle("")
      setBlackboardSummary("")
    } catch (error) {
      setBlackboardError(error instanceof Error ? error.message : "无法发布黑板信息。")
    } finally {
      setBlackboardPublishing(false)
    }
  }

  function versionDiffSummary(version: SessionRunPlanVersion) {
    const current = props.runPlan
    if (!current || version.version === current.version) return "\u5f53\u524d\u65b9\u6848\u5feb\u7167"
    const previous = new Map(version.snapshot.tasks.map((task) => [task.id, task]))
    const currentTasks = new Map(current.tasks.map((task) => [task.id, task]))
    const added = current.tasks.filter((task) => !previous.has(task.id)).length
    const removed = version.snapshot.tasks.filter((task) => !currentTasks.has(task.id)).length
    const changed = current.tasks.filter((task) => {
      const prior = previous.get(task.id)
      return prior && (prior.title !== task.title || prior.dependsOn.join("\u0000") !== task.dependsOn.join("\u0000"))
    }).length
    const parts = [
      ...(current.mode !== version.snapshot.mode ? [`\u6a21\u5f0f ${version.snapshot.mode} → ${current.mode}`] : []),
      ...(added ? [`\u65b0\u589e ${added} \u4e2a\u4efb\u52a1`] : []),
      ...(removed ? [`\u79fb\u9664 ${removed} \u4e2a\u4efb\u52a1`] : []),
      ...(changed ? [`\u4fee\u6539 ${changed} \u4e2a\u4efb\u52a1`] : []),
    ]
    return parts.length ? parts.join("\u00b7") : "\u65b9\u6848\u7ed3\u6784\u672a\u53d8\u5316"
  }

  return (
    <>
      <section
        class="session-workbench"
        aria-labelledby="workspace-session-title"
        tabindex="0"
        onKeyDown={(event) => {
          const target = event.target
          if (target instanceof HTMLElement && target.closest("input, textarea, select, button, details, [contenteditable='true']")) return
          if (!/^[1-7]$/u.test(event.key)) return
          const tab = tabs[Number(event.key) - 1]
          if (!tab) return
          event.preventDefault()
          setActiveTab(tab.id)
        }}
      >
        <header class="session-workbench__header">
          <div class="session-workbench__title">
            <Show when={props.context}>{props.context}</Show>
            <span>{copy.workflow}</span>
            <h1 id="workspace-session-title">{displaySessionTitle(props.session.title)}</h1>
          </div>
          <div class="session-workbench__controls">
            <details class="workflow-picker">
              <summary aria-label={copy.switchWorkflow}>
                <PanelsTopLeft aria-hidden="true" />
                <span>{activeWorkflowOption().label}</span>
              </summary>
              <div class="workflow-picker__menu" role="menu" aria-label={copy.switchWorkflow}>
                <For each={workflowOptions}>
                  {(workflow) => (
                    <button
                      type="button"
                      role="menuitemradio"
                      aria-checked={selectedWorkflow() === workflow.id}
                      disabled={workflowSaving() || selectedWorkflow() === workflow.id}
                      onClick={(event) => {
                        const details = event.currentTarget.closest("details")
                        void selectWorkflow(workflow).then((selected) => {
                          if (selected) details?.removeAttribute("open")
                        })
                      }}
                    >
                      <strong>{workflow.label}</strong>
                      <small>{workflow.description}</small>
                    </button>
                  )}
                </For>
                <Show when={workflowError()}>{(message) => <p class="workflow-picker__error" role="alert">{message()}</p>}</Show>
              </div>
            </details>
            <Show when={props.runPlan && props.onSetPlanMode}>
              <div class="session-workbench__mode" aria-label={copy.workflow}>
                <button type="button" aria-pressed={props.runPlan?.mode === "single"} onClick={() => setPendingMode("single")}>{copy.modeSingle}</button>
                <button type="button" aria-pressed={props.runPlan?.mode === "multi"} onClick={() => setPendingMode("multi")}>{copy.modeMulti}</button>
              </div>
            </Show>
            <span class="session-workbench__status" data-tone={status()}><Radio aria-hidden="true" />{workspaceStatusLabel(status())}</span>
          </div>
        </header>

        <Show when={workflowError()}>{(message) => <p class="session-workbench__notice" role="alert">{message()}</p>}</Show>
        <Show when={pendingMode()}>
          {(mode) => (
            <section class="session-workbench__notice session-workbench__notice--dialog" role="dialog" aria-label={copy.workflow}>
              <div>
                <strong>{mode() === "multi" ? copy.modeMulti : copy.modeSingle}</strong>
                <p>{"\u5df2\u9a8c\u6536\u7684\u7ed3\u679c\u4f1a\u4fdd\u7559\uff0c\u5c1a\u672a\u5f00\u59cb\u7684\u4efb\u52a1\u4f1a\u5728\u4e0b\u4e00\u4e2a\u5b89\u5168\u68c0\u67e5\u70b9\u6309\u65b0\u6a21\u5f0f\u7ee7\u7eed\u3002"}</p>
                <Show when={modeError()}>{(message) => <span role="alert">{message()}</span>}</Show>
              </div>
              <div class="session-workbench__actions">
                <Button type="button" size="small" loading={modeSaving()} loadingLabel={copy.saving} onClick={() => void confirmModeChange()}>{copy.save}</Button>
                <Button type="button" size="small" variant="ghost" disabled={modeSaving()} onClick={() => { setPendingMode(undefined); setModeError(undefined) }}>{copy.cancel}</Button>
              </div>
            </section>
          )}
        </Show>

        <div class="session-workbench__layout">
          <section class="session-workbench__canvas" data-expanded={expandedTab() ?? ""} aria-label={tr("session-workspace.workspace-tabs")}>
            <section class="session-workbench__control-shelf" aria-label={copy.controls}>
              <header><div><PanelsTopLeft aria-hidden="true" /><strong>{copy.controls}</strong></div><span>{copy.controlsNote}</span></header>
              <div>{props.requestArea}{props.commandBar}</div>
            </section>

            <div class="workbench-board" aria-label={tr("session-workspace.workspace-tabs")}>
              <section class="workbench-module-card workbench-live-panel workbench-live-panel--plan" data-module="plan">
                <header><div><ClipboardList aria-hidden="true" /><strong>{copy.plan}</strong></div><span>{props.runPlan ? `方案 v${props.runPlan.version}` : copy.waiting}</span></header>
                <div class="workbench-plan__meter"><span><i style={{ width: `${planTasks().length ? Math.round((acceptedPlanTasks() / planTasks().length) * 100) : 0}%` }} /></span><small>{planTasks().length ? `${acceptedPlanTasks()} / ${planTasks().length}` : "0 / 0"}</small></div>
                <Show when={planTasks().length} fallback={<p class="workbench-live-panel__empty">{copy.noPlan}</p>}>
                  <div class="workbench-live-task-list"><For each={planTasks().slice(0, 6)}>{(task) => <button type="button" data-tone={task.status} onClick={() => { setActiveTab("plan"); setExpandedTab("plan"); beginTaskEdit(task) }}><span /><strong>{task.title}</strong><small>{taskStatusLabel(task.status)}</small></button>}</For></div>
                </Show>
                <button class="workbench-live-panel__open" type="button" aria-label="编辑方案详细信息" onClick={() => { setActiveTab("plan"); setExpandedTab("plan") }}>{props.runPlan ? copy.editPlan : copy.expand}</button>
              </section>

              <section class="workbench-module-card workbench-live-panel" data-module="overview">
                <header><div><LayoutDashboard aria-hidden="true" /><strong>{copy.overview}</strong></div><span>{workspaceStatusLabel(status())}</span></header>
                <div class="workbench-overview__metrics"><article><small>{copy.currentStatus}</small><strong>{workspaceStatusLabel(status())}</strong></article><article><small>{copy.workflow}</small><strong>{activeWorkflowOption().label}</strong></article><article><small>{copy.nextStep}</small><strong>{nextStep()?.title ?? copy.waiting}</strong></article></div>
                <button class="workbench-live-panel__open" type="button" aria-label="查看概览详细信息" onClick={() => { setActiveTab("overview"); setExpandedTab("overview") }}>{copy.expand}</button>
              </section>

              <section class="workbench-module-card workbench-live-panel workbench-live-panel--agents" data-module="agents">
                <header><div><Bot aria-hidden="true" /><strong>{copy.agents}</strong></div><span>{agentNodes().length} 在线</span></header>
                <div class="workbench-agent-mini-flow"><div class="workbench-agent-mini-flow__root"><Bot aria-hidden="true" /><span>{copy.mainAgent}</span></div><div class="workbench-agent-mini-flow__line" /><div class="workbench-agent-mini-flow__nodes"><For each={agentNodes().slice(0, 3)}>{(agent) => <button type="button" data-status={agent.status} onClick={() => { setSelectedAgentID(agent.id); setActiveTab("agents"); setExpandedTab("agents") }}><span /><strong>{agent.name}</strong><small>{agent.role}</small></button>}</For></div></div>
                <Show when={!agentNodes().length}><p class="workbench-live-panel__empty">{copy.noAgents}</p></Show>
                <button class="workbench-live-panel__open" type="button" aria-label="查看智能体详细信息" onClick={() => { setActiveTab("agents"); setExpandedTab("agents") }}>{copy.expand}</button>
              </section>

              <section class="workbench-module-card workbench-live-panel" data-module="blackboard">
                <header><div><Boxes aria-hidden="true" /><strong>{copy.blackboard}</strong></div><span>{props.blackboard?.length ?? 0} 条</span></header>
                <Show when={props.blackboard?.length} fallback={<p class="workbench-live-panel__empty">智能体可在此发布决策、约束和风险。</p>}><div class="workbench-blackboard-mini"><For each={props.blackboard?.slice(0, 3)}>{(card) => <article><strong>{card.title}</strong><small>{card.authorAgentID} · {blackboardTypeLabel(card.type)}</small></article>}</For></div></Show>
                <button class="workbench-live-panel__open" type="button" aria-label="发布或查看黑板信息" onClick={() => { setActiveTab("blackboard"); setExpandedTab("blackboard") }}>{copy.publish}</button>
              </section>

              <section class="workbench-module-card workbench-live-panel" data-module="review">
                <header><div><GitPullRequest aria-hidden="true" /><strong>{copy.review}</strong></div><span>{props.reviews?.length ?? 0} 项</span></header>
                <Show when={props.reviews?.length} fallback={<p class="workbench-live-panel__empty">{copy.noAttention}</p>}><div class="workbench-record-mini"><For each={props.reviews?.slice(0, 3)}>{(review) => <article><strong>{review.summary}</strong><small>{taskStatusLabel(review.status)}</small></article>}</For></div></Show>
                <button class="workbench-live-panel__open" type="button" aria-label="查看审核详细信息" onClick={() => { setActiveTab("review"); setExpandedTab("review") }}>{copy.expand}</button>
              </section>

              <section class="workbench-module-card workbench-live-panel" data-module="deliverables">
                <header><div><FileCheck2 aria-hidden="true" /><strong>{copy.deliverables}</strong></div><span>{props.artifacts?.length ?? 0} 个</span></header>
                <Show when={props.artifacts?.length} fallback={<p class="workbench-live-panel__empty">{copy.noArtifacts}</p>}><div class="workbench-record-mini"><For each={props.artifacts?.slice(0, 3)}>{(artifact) => <article><strong>{artifact.name}</strong><small>{artifact.mediaType}</small></article>}</For></div></Show>
                <button class="workbench-live-panel__open" type="button" aria-label="查看交付物详细信息" onClick={() => { setActiveTab("deliverables"); setExpandedTab("deliverables") }}>{copy.expand}</button>
              </section>

              <section class="workbench-module-card workbench-live-panel" data-module="diff">
                <header><div><GitCompareArrows aria-hidden="true" /><strong>{copy.diff}</strong></div><span>{props.planVersions?.length ?? 0} 版</span></header>
                <Show when={(props.planVersions?.length ?? 0) > 1} fallback={<p class="workbench-live-panel__empty">{copy.noDiff}</p>}><div class="workbench-record-mini"><For each={props.planVersions?.slice(0, 3)}>{(version) => <article><strong>{`方案 v${version.version}`}</strong><small>{version.reason}</small></article>}</For></div></Show>
                <button class="workbench-live-panel__open" type="button" aria-label="查看差异详细信息" onClick={() => { setActiveTab("diff"); setExpandedTab("diff") }}>{copy.expand}</button>
              </section>
            </div>

            <Show when={expandedTab()}>
              {(tab) => (
                <section class="workbench-module-detail" data-module={tab()} aria-label={copy[tab()]}>
                  <header class="workbench-module-detail__header">
                    <div><span>{copy[tab()]}</span><small>{modulePreview(tab())}</small></div>
                    <Button type="button" size="small" variant="ghost" onClick={() => setExpandedTab(undefined)}><X aria-hidden="true" />{copy.close}</Button>
                  </header>
            <Show when={expandedTab() === "overview"}>
              <div class="workbench-overview">
                <section class="workbench-card workbench-card--primary">
                  <header><span>{copy.currentStatus}</span><span data-tone={status()}>{workspaceStatusLabel(status())}</span></header>
                  <strong>{planTasks().length ? `${copy.plan} v${props.runPlan!.version}` : copy.noPlan}</strong>
                  <p>{planTasks().length ? tr("session-workspace.progress", { completed: acceptedPlanTasks(), total: planTasks().length }) : copy.noPlan}</p>
                </section>
                <section class="workbench-card">
                  <header><span>{copy.workflow}</span><Network aria-hidden="true" /></header>
                  <strong>{activeWorkflowOption().label}</strong>
                  <p>{activeWorkflowOption().description}</p>
                </section>
                <section class="workbench-card">
                  <header><span>{copy.activeAgents}</span><UsersRound aria-hidden="true" /></header>
                  <strong>{agentNodes().length} / {planTasks().length}</strong>
                  <p>{agentNodes().length ? copy.agentFlowNote : copy.noAgents}</p>
                </section>
                <section class="workbench-card" data-tone={attention().length ? "attention" : "ready"}>
                  <header><span>{copy.attention}</span><ShieldAlert aria-hidden="true" /></header>
                  <strong>{attention().length ? `${attention().length} ${copy.attention}` : copy.ready}</strong>
                  <p>{attention().length ? attention().map((task) => task.title).join("\u00b7") : copy.noAttention}</p>
                </section>
                <section class="workbench-wide-card">
                  <header><span>{copy.nextStep}</span><small>{taskStatusLabel(nextStep()?.status)}</small></header>
                  <strong>{nextStep()?.title ?? copy.waiting}</strong>
                  <p>{nextStep() ? `${nextStep()!.assignee ?? copy.mainAgent}\u00b7${nextStep()!.dependsOn.length ? nextStep()!.dependsOn.join(", ") : copy.ready}` : copy.noPending}</p>
                </section>
                <section class="workbench-wide-card">
                  <header><span>{copy.latestArtifacts}</span><small>{props.artifacts?.length ?? 0}</small></header>
                  <Show when={props.artifacts?.length} fallback={<p>{copy.noArtifacts}</p>}>
                    <ul><For each={props.artifacts?.slice(0, 3)}>{(artifact) => <li><strong>{artifact.name}</strong><small>{artifact.summary}</small></li>}</For></ul>
                  </Show>
                </section>
              </div>
            </Show>

            <Show when={expandedTab() === "plan"}>
              <div class="workbench-plan">
                <section class="workbench-panel">
                  <header class="workbench-panel__header"><div><ClipboardList aria-hidden="true" /><h2>{copy.plan}</h2></div><small>{props.runPlan ? `v${props.runPlan.version}` : copy.waiting}</small></header>
                  <Show when={planTasks().length} fallback={<EmptyPanel icon={ClipboardList} title={copy.noPlan} />}>
                    <div class="workbench-plan__filters">
                      <input value={planSearch()} onInput={(event) => setPlanSearch(event.currentTarget.value)} placeholder={copy.searchTasks} aria-label={copy.searchTasks} />
                      <select value={planStatusFilter()} onChange={(event) => setPlanStatusFilter(event.currentTarget.value)} aria-label={copy.allStatuses}>
                        <option value="all">{copy.allStatuses}</option>
                        <For each={[...new Set(planTasks().map((task) => task.status))]}>{(item) => <option value={item}>{taskStatusLabel(item)}</option>}</For>
                      </select>
                      <label><input type="checkbox" checked={hideCompleted()} onChange={(event) => setHideCompleted(event.currentTarget.checked)} />{copy.hideAccepted}</label>
                    </div>
                    <div class="workbench-plan__tasks">
                      <For each={visiblePlanTasks()}>{(task) => <article data-tone={task.status === "accepted" ? "success" : task.status === "failed" || task.status === "blocked" ? "danger" : "active"}><span class="workbench-plan__task-dot" aria-hidden="true" /><div><small>{task.stageID} / {task.stepID}</small><strong>{task.title}</strong><p>{task.dependsOn.length ? task.dependsOn.join(", ") : copy.ready}</p></div><span>{taskStatusLabel(task.status)}</span><Show when={props.onPatchRunPlan && task.status !== "accepted"}><Button type="button" size="small" variant="ghost" onClick={() => beginTaskEdit(task)}>编辑</Button></Show></article>}</For>
                    </div>
                  </Show>
                </section>
                <section class="workbench-panel workbench-panel--edit">
                  <header class="workbench-panel__header"><div><PenLine aria-hidden="true" /><h2>{copy.editPlan}</h2></div><small>{"\u4fee\u6539\u4f1a\u65b0\u5efa\u65b9\u6848\u7248\u672c"}</small></header>
                  <Show when={props.onPatchRunPlan && planTasks().length} fallback={<p>{"\u65b9\u6848\u751f\u6210\u540e\uff0c\u53ef\u5728\u6b64\u5904\u76f4\u63a5\u4fee\u6539\u4efb\u52a1\u3002"}</p>}>
                    <label class="workbench-field">{copy.task}<select value={editingTaskID() ?? ""} onChange={(event) => { const task = planTasks().find((candidate) => candidate.id === event.currentTarget.value); if (task) beginTaskEdit(task) }}><option value="" disabled>{copy.selectTask}</option><For each={planTasks()}>{(task) => <option value={task.id}>{task.title}</option>}</For></select></label>
                    <Show when={editingTask()} fallback={<p>{copy.selectTask}</p>}>
                      <form class="workbench-edit-form" onSubmit={(event) => { event.preventDefault(); void saveTaskEdit() }}>
                        <label class="workbench-field">{copy.taskName}<input value={draftTitle()} onInput={(event) => setDraftTitle(event.currentTarget.value)} /></label>
                        <label class="workbench-field">{copy.dependencies}<input value={draftDependsOn()} onInput={(event) => setDraftDependsOn(event.currentTarget.value)} placeholder="task-1, task-2" /></label>
                        <Show when={patchError()}>{(message) => <p class="workbench-error" role="alert">{message()}</p>}</Show>
                        <div class="session-workbench__actions"><Button type="submit" size="small" loading={patching()} loadingLabel={copy.saving}><Save aria-hidden="true" />{copy.save}</Button><Button type="button" size="small" variant="ghost" disabled={patching()} onClick={cancelTaskEdit}><X aria-hidden="true" />{copy.cancel}</Button></div>
                      </form>
                    </Show>
                  </Show>
                </section>
                <Show when={props.runPlan}>
                  <section class="workbench-panel workbench-panel--source">
                    <header class="workbench-panel__header"><div><Braces aria-hidden="true" /><h2>{copy.planSource}</h2></div><Show when={props.onPatchRunPlan && !yamlEditing()}><Button type="button" variant="ghost" size="small" onClick={openYamlEditor}>{copy.editSource}</Button></Show></header>
                    <Show when={yamlEditing()} fallback={<pre>{planYaml()}</pre>}>
                      <form class="workbench-edit-form" onSubmit={(event) => { event.preventDefault(); void saveYamlEdit() }}><textarea value={yamlDraft()} onInput={(event) => setYamlDraft(event.currentTarget.value)} spellcheck={false} aria-label={copy.editSource} /><Show when={yamlError()}>{(message) => <p class="workbench-error" role="alert">{message()}</p>}</Show><div class="session-workbench__actions"><Button type="submit" size="small" loading={yamlSaving()} loadingLabel={copy.saving}>{copy.save}</Button><Button type="button" size="small" variant="ghost" disabled={yamlSaving()} onClick={() => { setYamlEditing(false); setYamlError(undefined) }}>{copy.cancel}</Button></div></form>
                    </Show>
                  </section>
                </Show>
              </div>
            </Show>

            <Show when={expandedTab() === "agents"}>
              <div class="workbench-agents">
                <section class="workbench-panel workbench-agent-flow">
                  <header class="workbench-panel__header"><div><UsersRound aria-hidden="true" /><h2>{copy.agentFlow}</h2></div><small>{copy.agentFlowNote}</small></header>
                  <Show when={agentNodes().length} fallback={<EmptyPanel icon={Bot} title={copy.noAgents} />}>
                    <div class="agent-flow" role="list" aria-label={copy.agentFlow}>
                      <div class="agent-flow__hub"><Bot aria-hidden="true" /><strong>{copy.mainAgent}</strong><span>{copy.running}</span></div>
                      <div class="agent-flow__network" aria-hidden="true"><i /><i /><i /></div>
                      <div class="agent-flow__nodes"><For each={agentNodes()}>{(agent) => <button type="button" role="listitem" data-status={agent.status} aria-pressed={selectedAgentNode()?.id === agent.id} onClick={() => setSelectedAgentID(agent.id)}><span class="agent-flow__pulse" aria-hidden="true" /><small>{agent.role}</small><strong>{agent.name}</strong><span>{taskStatusLabel(agent.status)}</span></button>}</For></div>
                    </div>
                  </Show>
                </section>
                <section class="workbench-panel workbench-agent-detail">
                  <header class="workbench-panel__header"><div><CircleDot aria-hidden="true" /><h2>{copy.selectedAgent}</h2></div><small>{taskStatusLabel(selectedAgentNode()?.status)}</small></header>
                  <Show when={selectedAgentNode()} fallback={<p>{copy.noAgents}</p>}>
                    {(agent) => <><strong>{agent().name}</strong><p>{agent().role}</p><dl><div><dt>{copy.task}</dt><dd>{agent().task}</dd></div><div><dt>{copy.currentStatus}</dt><dd>{taskStatusLabel(agent().status)}</dd></div><div><dt>{copy.blackboard}</dt><dd>{agent().detail}</dd></div></dl></>}
                  </Show>
                </section>
              </div>
            </Show>

            <Show when={expandedTab() === "blackboard"}>
              <div class="workbench-blackboard">
                <section class="workbench-panel workbench-blackboard__publish">
                  <header class="workbench-panel__header"><div><PenLine aria-hidden="true" /><h2>{copy.publish}</h2></div><small>{copy.blackboardNote}</small></header>
                  <Show when={props.onPublishBlackboard} fallback={<p>黑板发布入口暂不可用。</p>}>
                    <form class="workbench-edit-form" onSubmit={(event) => { event.preventDefault(); void publishBlackboard() }}>
                      <div class="workbench-blackboard__fields">
                        <label class="workbench-field">信息类型<select value={blackboardType()} onChange={(event) => setBlackboardType(event.currentTarget.value as SessionBlackboardDraft["type"])}><option value="proposal">提案</option><option value="decision">决策</option><option value="constraint">约束</option><option value="evidence">证据</option><option value="risk">风险</option><option value="blocker">阻塞</option><option value="contract">约定</option></select></label>
                        <label class="workbench-field">{copy.blackboardAuthor}<select value={blackboardAuthor()} onChange={(event) => setBlackboardAuthor(event.currentTarget.value)}><option value="">{selectedAgentNode()?.name ?? copy.mainAgent}</option><For each={agentNodes()}>{(agent) => <option value={agent.name}>{agent.name}</option>}</For></select></label>
                      </div>
                      <label class="workbench-field">{copy.blackboardTitle}<input value={blackboardTitle()} onInput={(event) => setBlackboardTitle(event.currentTarget.value)} placeholder="例如：接口变更需兼容现有数据" /></label>
                      <label class="workbench-field">{copy.blackboardSummary}<textarea value={blackboardSummary()} onInput={(event) => setBlackboardSummary(event.currentTarget.value)} placeholder="写入其他智能体需要知道的结论、依据或风险。" /></label>
                      <Show when={blackboardError()}>{(message) => <p class="workbench-error" role="alert">{message()}</p>}</Show>
                      <div class="session-workbench__actions"><Button type="submit" size="small" loading={blackboardPublishing()} loadingLabel={copy.publishing}>{copy.publish}</Button></div>
                    </form>
                  </Show>
                </section>
                <section class="workbench-panel workbench-list-panel">
                  <header class="workbench-panel__header"><div><Boxes aria-hidden="true" /><h2>{copy.blackboard}</h2></div><small>{props.blackboard?.length ?? 0} 条共享信息</small></header>
                  <Show when={props.blackboard?.length} fallback={<EmptyPanel icon={Boxes} title={tr("session-workspace.no-blackboard-yet")} />}><div class="workbench-record-list"><For each={props.blackboard}>{(card) => <article data-status={card.status}><header><span>{blackboardTypeLabel(card.type)} · {card.authorAgentID}</span><span>{taskStatusLabel(card.status)}</span></header><strong>{card.title}</strong><p>{card.summary}</p><small>影响范围：{card.impactScope === "high" ? "高" : card.impactScope === "low" ? "低" : "中"}</small></article>}</For></div></Show>
                </section>
              </div>
            </Show>

            <Show when={expandedTab() === "review"}>
              <section class="workbench-panel workbench-list-panel"><header class="workbench-panel__header"><div><GitPullRequest aria-hidden="true" /><h2>{copy.review}</h2></div><small>{copy.reviewNote}</small></header><Show when={props.reviews?.length} fallback={<EmptyPanel icon={GitPullRequest} title={tr("session-workspace.no-review-yet")} />}><div class="workbench-record-list"><For each={props.reviews}>{(review) => <article data-status={review.severity}><header><span>{review.authorAgentID}</span><span>{taskStatusLabel(review.status)}</span></header><strong>{review.summary}</strong><p>{review.suggestion}</p></article>}</For></div></Show></section>
            </Show>

            <Show when={expandedTab() === "deliverables"}>
              <section class="workbench-panel workbench-list-panel"><header class="workbench-panel__header"><div><FileCheck2 aria-hidden="true" /><h2>{copy.deliverables}</h2></div><small>{copy.deliverablesNote}</small></header><Show when={props.artifacts?.length} fallback={<EmptyPanel icon={FileCheck2} title={tr("session-workspace.no-deliverables-yet")} />}><div class="workbench-record-list"><For each={props.artifacts}>{(artifact) => <article data-status="accepted"><header><span>{artifact.mediaType}</span><span>{copy.accepted}</span></header><strong>{artifact.name}</strong><p>{artifact.summary}</p><small>{artifact.uri}</small></article>}</For></div></Show></section>
            </Show>

            <Show when={expandedTab() === "diff"}>
              <section class="workbench-panel workbench-diff"><header class="workbench-panel__header"><div><GitCompareArrows aria-hidden="true" /><h2>{copy.diff}</h2></div><small>{copy.diffNote}</small></header><Show when={props.planVersions && props.planVersions.length > 1} fallback={<EmptyPanel icon={GitCompareArrows} title={copy.noDiff} />}><div class="workbench-diff__timeline"><For each={props.planVersions?.filter((version) => version.version !== props.runPlan?.version)}>{(version) => <article><span>v{version.version}</span><div><strong>{version.reason}</strong><p>{versionDiffSummary(version)}</p><small>{new Date(version.createdAt).toLocaleString()}</small></div><Show when={props.onRestoreRunPlanVersion}><Button type="button" variant="ghost" size="small" onClick={() => { setPendingRestoreVersion(version.version); setRestoreError(undefined) }}><History aria-hidden="true" />{copy.restore}</Button></Show></article>}</For></div><Show when={pendingRestoreVersion() !== undefined}><div class="workbench-restore"><p>{`v${pendingRestoreVersion()} ${copy.restore}`}</p><div class="session-workbench__actions"><Button type="button" size="small" loading={restoreSaving()} loadingLabel={copy.saving} onClick={() => void restoreVersion()}>{copy.restore}</Button><Button type="button" size="small" variant="ghost" disabled={restoreSaving()} onClick={() => { setPendingRestoreVersion(undefined); setRestoreError(undefined) }}>{copy.cancel}</Button></div><Show when={restoreError()}>{(message) => <p class="workbench-error" role="alert">{message()}</p>}</Show></div></Show></Show></section>
            </Show>
                </section>
              )}
            </Show>
          </section>

          <aside class="session-workbench__chat" aria-label={copy.chat}>
            <header><div><MessageSquare aria-hidden="true" /><strong>{copy.chat}</strong></div><span>{copy.chatNote}</span></header>
            <MessageTimeline messages={props.conversation?.messages ?? []} loading={props.conversationLoading} error={props.conversationError} planStatus={props.planStatus} onRetry={props.onRetryConversation} />
            <div class="session-workbench__composer">{props.composer}</div>
          </aside>
        </div>
      </section>
      {false && (
    <section class="session-workspace" aria-labelledby="workspace-session-title">
      <header class="session-workspace__header">
        <div class="session-workspace__identity">
          <Show
            when={props.context}
            fallback={<span class="session-workspace__eyebrow">{props.multiAgentEnabled ? tr("layout.multi-agent-model") : tr("layout.single-agent-mode")}</span>}
          >
            {props.context}
          </Show>
          <h1 id="workspace-session-title">{props.session.title}</h1>
        </div>
        <div class="session-workspace__header-controls">
          <Show when={props.runPlan && props.onSetPlanMode}>
            <div class="session-mode-switch" aria-label="Execution mode">
              <button type="button" aria-pressed={props.runPlan?.mode === "single"} onClick={() => setPendingMode("single")}>Single</button>
              <button type="button" aria-pressed={props.runPlan?.mode === "multi"} onClick={() => setPendingMode("multi")}>Multi</button>
            </div>
          </Show>
          <Show when={props.runPlan}><span class="session-plan-version">Plan v{props.runPlan!.version}</span></Show>
          <span class="session-workspace__status" data-tone={status()}>
            <Radio aria-hidden="true" />
            {workspaceStatusLabel(status())}
          </span>
        </div>
      </header>

      <Show when={pendingMode()}>
        {(mode) => (
          <section class="session-mode-impact" role="dialog" aria-label="Confirm execution mode change">
            <div><strong>Switch to {mode() === "multi" ? "Multi" : "Single"} execution?</strong><p>Accepted work remains preserved. Pending work will use the new Runtime dispatch mode on its next execution.</p><Show when={modeError()}>{(message) => <span role="alert">{message()}</span>}</Show></div>
            <div><Button type="button" size="small" loading={modeSaving()} loadingLabel="Switching" onClick={() => void confirmModeChange()}>Confirm switch</Button><Button type="button" size="small" variant="ghost" disabled={modeSaving()} onClick={() => { setPendingMode(undefined); setModeError(undefined) }}>Cancel</Button></div>
          </section>
        )}
      </Show>

      <nav class="session-workspace__tabs" aria-label={tr("session-workspace.workspace-tabs")} role="tablist">
        <For each={tabs}>
          {(tab) => {
            const Icon = tab.icon
            return (
              <button
                type="button"
                role="tab"
                id={`session-tab-${tab.id}`}
                aria-controls={`session-panel-${tab.id}`}
                aria-selected={activeTab() === tab.id}
                tabindex={activeTab() === tab.id ? 0 : -1}
                onClick={() => setActiveTab(tab.id)}
              >
                <Icon aria-hidden="true" />
                <span>{tr(tab.label)}</span>
              </button>
            )
          }}
        </For>
      </nav>

      <div class="session-workspace__body" role="tabpanel" id={`session-panel-${active().id}`} aria-labelledby={`session-tab-${active().id}`}>
        <Show when={activeTab() === "overview"}>
          <div class="session-overview">
            <section class="session-card session-card--primary">
              <div class="session-card__heading">
                <span>{tr("session-workspace.current-status")}</span>
                <span class="session-card__tag" data-tone={status()}>{workspaceStatusLabel(status())}</span>
              </div>
              <strong>{planTasks().length ? `${tr("session-workspace.plan")} v${props.runPlan!.version}` : tr("session-workspace.awaiting-plan")}</strong>
              <p>
                {planTasks().length
                  ? tr("session-workspace.progress", { completed: acceptedPlanTasks(), total: planTasks().length })
                  : tr("session-workspace.no-plan-yet")}
              </p>
            </section>
            <section class="session-card">
              <div class="session-card__heading"><span>{tr("session-workspace.workflow")}</span><Network aria-hidden="true" /></div>
              <strong>{props.runPlan ? `${props.runPlan!.workflowID} · ${props.runPlan!.mode}` : props.multiAgentEnabled ? tr("layout.multi-agent-model") : tr("layout.single-agent-mode")}</strong>
              <p>{tr("session-workspace.workflow-note")}</p>
            </section>
            <section class="session-card">
              <div class="session-card__heading"><span>{tr("session-workspace.active-agents")}</span><Bot aria-hidden="true" /></div>
              <strong>{planTasks().length ? `${runningPlanTasks().length} / ${planTasks().length}` : "0 / 0"}</strong>
              <p>{tr("session-workspace.agent-note")}</p>
            </section>
            <section class="session-card session-card--attention">
              <div class="session-card__heading"><span>{tr("session-workspace.attention")}</span><ShieldAlert aria-hidden="true" /></div>
              <strong>{attention().length ? tr("session-workspace.requires-attention") : tr("session-workspace.clear")}</strong>
              <p>{attention().length ? attention().map((task) => task.title).join(" · ") : tr("session-workspace.nothing-blocking")}</p>
            </section>
            <section class="session-overview__detail" aria-label="Next step and latest artifacts">
              <article>
                <header><span>Next step</span><small>{nextStep()?.status ?? "waiting"}</small></header>
                <strong>{nextStep()?.title ?? "Waiting for the next request"}</strong>
                <p>{nextStep() ? `Owner: ${nextStep()!.assignee ?? "main agent"} · ${nextStep()!.dependsOn.length ? `depends on ${nextStep()!.dependsOn.join(", ")}` : "ready when execution starts"}` : "The current plan has no pending work."}</p>
              </article>
              <article>
                <header><span>Latest shared artifacts</span><small>{props.artifacts?.length ?? 0}</small></header>
                <Show when={props.artifacts?.length} fallback={<p>No shared artifacts have been published yet.</p>}>
                  <ul><For each={props.artifacts?.slice(0, 3)}>{(artifact) => <li><strong>{artifact.name}</strong><small>{artifact.summary}</small></li>}</For></ul>
                </Show>
              </article>
            </section>
          </div>
        </Show>

        <Show when={activeTab() === "plan"}>
          <section class="session-detail-list" aria-label={tr("session-workspace.plan")}> 
            <Show when={planTasks().length} fallback={<EmptyPanel icon={ClipboardList} title={tr("session-workspace.no-plan-yet")} />}>
              <section class="session-plan-controls" aria-label="Filter plan tasks">
                <input value={planSearch()} onInput={(event) => setPlanSearch(event.currentTarget.value)} placeholder="Search tasks" aria-label="Search plan tasks" />
                <select value={planStatusFilter()} onChange={(event) => setPlanStatusFilter(event.currentTarget.value)} aria-label="Filter by task status">
                  <option value="all">All statuses</option>
                  <For each={[...new Set(planTasks().map((task) => task.status))]}>{(status) => <option value={status}>{status}</option>}</For>
                </select>
                <label><input type="checkbox" checked={hideCompleted()} onChange={(event) => setHideCompleted(event.currentTarget.checked)} /> Hide accepted</label>
                <small>{visiblePlanTasks().length} of {planTasks().length} tasks</small>
              </section>
              <For each={visiblePlanTasks()}>
                {(task) => <article class="session-plan-step" data-tone={task.status === "accepted" ? "success" : task.status === "failed" || task.status === "blocked" ? "danger" : "active"}><header><span>{task.stageID} / {task.stepID}</span><small>{task.status}</small></header><div class="session-plan-task" data-tone={task.status === "accepted" ? "success" : task.status === "failed" || task.status === "blocked" ? "danger" : "active"}><span aria-hidden="true" /><strong>{task.title}</strong><small>{task.assignee ?? "—"}</small></div></article>}
              </For>
            </Show>
            <Show when={props.onPatchRunPlan && planTasks().length}>
              <section class="session-plan-editor-shell" aria-label="Edit run plan">
                <header><span>Plan editor</span><small>Changes are version protected</small></header>
                <label>
                  Task
                  <select
                    value={editingTaskID() ?? ""}
                    onChange={(event) => {
                      const task = planTasks().find((candidate) => candidate.id === event.currentTarget.value)
                      if (task) beginTaskEdit(task)
                    }}
                  >
                    <option value="" disabled>Select a task to edit</option>
                    <For each={planTasks()}>{(task) => <option value={task.id}>{task.id} — {task.title}</option>}</For>
                  </select>
                </label>
                <Show when={editingTask()} fallback={<p>Select a task to update its natural-language title or dependency IDs.</p>}>
                  <form class="session-plan-editor" onSubmit={(event) => { event.preventDefault(); void saveTaskEdit() }}>
                    <label>Task title<input value={draftTitle()} onInput={(event) => setDraftTitle(event.currentTarget.value)} autofocus /></label>
                    <label>Depends on <small>Comma-separated task IDs</small><input value={draftDependsOn()} onInput={(event) => setDraftDependsOn(event.currentTarget.value)} placeholder="task-1, task-2" /></label>
                    <Show when={patchError()}>{(message) => <p class="session-plan-editor__error" role="alert">{message()}</p>}</Show>
                    <div class="session-plan-editor__actions">
                      <Button type="submit" size="small" loading={patching()} loadingLabel="Saving"><Save aria-hidden="true" />Save change</Button>
                      <Button type="button" variant="ghost" size="small" disabled={patching()} onClick={cancelTaskEdit}><X aria-hidden="true" />Cancel</Button>
                    </div>
                  </form>
                </Show>
              </section>
            </Show>
            <Show when={visiblePlanTasks().length > 1}>
              <section class="session-plan-graph" aria-label="Plan dependency graph">
                <header><span>Dependency graph</span><small>{visiblePlanTasks().length} nodes</small></header>
                <div class="session-plan-graph__nodes">
                  <For each={visiblePlanTasks()}>{(task) => <article data-state={task.status}><strong>{task.title}</strong><small>{task.dependsOn.length ? `after ${task.dependsOn.join(", ")}` : "root task"}</small></article>}</For>
                </div>
              </section>
            </Show>
            <Show when={props.runPlan}>
              <section class="session-plan-source" aria-label="Run Plan YAML">
                <header>
                  <span>Plan YAML</span>
                  <Show when={props.onPatchRunPlan && !yamlEditing()}>
                    <Button type="button" variant="ghost" size="small" onClick={openYamlEditor}>Edit YAML</Button>
                  </Show>
                </header>
                <Show
                  when={yamlEditing()}
                  fallback={<pre>{planYaml()}</pre>}
                >
                  <form class="session-plan-yaml-editor" onSubmit={(event) => { event.preventDefault(); void saveYamlEdit() }}>
                    <textarea value={yamlDraft()} onInput={(event) => setYamlDraft(event.currentTarget.value)} spellcheck={false} aria-label="Editable Run Plan YAML" />
                    <Show when={yamlError()}>{(message) => <p class="session-plan-editor__error" role="alert">{message()}</p>}</Show>
                    <div class="session-plan-editor__actions">
                      <Button type="submit" size="small" loading={yamlSaving()} loadingLabel="Saving"><Save aria-hidden="true" />Save YAML</Button>
                      <Button type="button" variant="ghost" size="small" disabled={yamlSaving()} onClick={() => { setYamlEditing(false); setYamlError(undefined) }}><X aria-hidden="true" />Cancel</Button>
                    </div>
                  </form>
                </Show>
              </section>
            </Show>
            <Show when={(props.planVersions?.length ?? 0) > 1}>
              <section class="session-plan-history" aria-label="Run Plan version history">
                <header><span>Version history</span><small>{props.planVersions!.length} snapshots</small></header>
                <p>Snapshots are immutable. Restoring creates a new version and preserves tasks that have already started.</p>
                <div class="session-plan-history__items">
                  <For each={props.planVersions ?? []}>
                    {(version) => (
                      <article data-current={version.version === props.runPlan?.version}>
                        <div><strong>v{version.version}</strong><span>{version.reason}</span><small>{version.author} · {new Date(version.createdAt).toLocaleString()}</small></div>
                        <div><small>{versionDiffSummary(version)}</small><Show when={version.version !== props.runPlan?.version && props.onRestoreRunPlanVersion}><Button type="button" variant="ghost" size="small" onClick={() => { setPendingRestoreVersion(version.version); setRestoreError(undefined) }}>Restore</Button></Show></div>
                      </article>
                    )}
                  </For>
                </div>
                <Show when={pendingRestoreVersion() !== undefined}>
                  <div class="session-plan-history__confirm">
                    <p>Restore v{pendingRestoreVersion()} as a new version? Active or accepted tasks will never be removed automatically.</p>
                    <div class="session-plan-editor__actions"><Button type="button" size="small" loading={restoreSaving()} loadingLabel="Restoring" onClick={() => void restoreVersion()}>Restore version</Button><Button type="button" variant="ghost" size="small" disabled={restoreSaving()} onClick={() => { setPendingRestoreVersion(undefined); setRestoreError(undefined) }}>Cancel</Button></div>
                  </div>
                </Show>
                <Show when={restoreError()}>{(message) => <p class="session-plan-editor__error" role="alert">{message()}</p>}</Show>
              </section>
            </Show>
          </section>
        </Show>

        <Show when={activeTab() === "agents"}>
          <section class="session-agents" aria-label={tr("session-workspace.agents")}>
            <article class="session-agent-card session-agent-card--main" data-tone="active"><span class="session-agent-card__role">Orchestrator</span><strong>Main Agent</strong><p>{nextStep()?.title ?? "Coordinates the current Session and integrates accepted work."}</p><footer><span>{props.status?.type === "busy" ? "coordinating" : "ready"}</span><small>{props.runPlan ? `Plan v${props.runPlan!.version}` : "no plan"}</small></footer></article>
            <Show when={props.assignments?.length} fallback={<Show when={planTasks().length} fallback={<EmptyPanel icon={Bot} title={tr("session-workspace.no-agents-yet")} />}><For each={planTasks()}>{(task) => <article class="session-agent-card" data-tone={task.status === "accepted" ? "success" : task.status === "failed" ? "danger" : "active"}><span class="session-agent-card__role">{task.assignee ?? "main-agent"}</span><strong>{task.title}</strong><p>{task.acceptance.map((rule) => rule.title).join(" ")}</p><footer><span>{task.status}</span><small>{task.stageID}</small></footer></article>}</For></Show>}>
              <For each={props.assignments}>
                {(assignment) => <article class="session-agent-card" data-tone={assignment.status === "completed" ? "success" : assignment.status === "failed" || assignment.status === "interrupted" ? "danger" : "active"}><span class="session-agent-card__role">{assignment.role}</span><strong>{assignment.agentID}</strong><p>{assignment.checkpoint ?? assignment.workspaceID}</p><footer><span>{assignment.status}</span><small>{assignment.childSessionID ?? assignment.nodeID}</small></footer></article>}
              </For>
            </Show>
          </section>
        </Show>

        <Show when={activeTab() === "blackboard"}><section class="session-detail-list" aria-label={tr("session-workspace.blackboard")}><Show when={props.blackboard?.length} fallback={<EmptyPanel icon={Boxes} title={tr("session-workspace.no-blackboard-yet")} />}><For each={props.blackboard}>{(card) => <article class="session-plan-step" data-tone={card.status === "accepted" ? "success" : "active"}><header><span>{card.title}</span><small>{card.status}</small></header><div class="session-plan-task" data-tone="active"><span aria-hidden="true" /><strong>{card.summary}</strong><small>{card.type}</small></div></article>}</For></Show></section></Show>
        <Show when={activeTab() === "review"}><section class="session-detail-list" aria-label={tr("session-workspace.review")}><Show when={props.reviews?.length} fallback={<EmptyPanel icon={GitPullRequest} title={tr("session-workspace.no-review-yet")} />}><For each={props.reviews}>{(review) => <article class="session-plan-step" data-tone={review.severity === "critical" || review.severity === "high" ? "danger" : "active"}><header><span>{review.summary}</span><small>{review.status}</small></header><div class="session-plan-task" data-tone="active"><span aria-hidden="true" /><strong>{review.suggestion}</strong><small>{review.severity}</small></div></article>}</For></Show></section></Show>
        <Show when={activeTab() === "deliverables"}>
          <section class="session-detail-list" aria-label={tr("session-workspace.deliverables")}>
            <Show when={props.artifacts?.length} fallback={<EmptyPanel icon={FileCheck2} title={tr("session-workspace.no-deliverables-yet")} />}>
              <For each={props.artifacts}>
                {(artifact) => (
                  <article class="session-plan-step" data-tone="success">
                    <header><span>{artifact.name}</span><small>{artifact.mediaType}</small></header>
                    <div class="session-plan-task" data-tone="success"><span aria-hidden="true" /><strong>{artifact.summary}</strong><small>{artifact.uri}</small></div>
                  </article>
                )}
              </For>
            </Show>
          </section>
        </Show>
      </div>

      <section class="session-dock" aria-label={tr("session-workspace.session-dock")}>
        <header class="session-dock__tabs" role="tablist"><button type="button" role="tab" aria-selected={dockTab() === "chat"} onClick={() => setDockTab("chat")}><MessageSquare aria-hidden="true" />{tr("session-workspace.conversation")}</button><button type="button" role="tab" aria-selected={dockTab() === "collaboration"} onClick={() => setDockTab("collaboration")}>Collaboration</button><button type="button" role="tab" aria-selected={dockTab() === "events"} onClick={() => setDockTab("events")}>Events</button></header>
        <Show when={dockTab() === "chat"}>
          <MessageTimeline
            messages={props.conversation?.messages ?? []}
            loading={props.conversationLoading}
            error={props.conversationError}
            planStatus={props.planStatus}
            onRetry={props.onRetryConversation}
          />
        </Show>
        <Show when={dockTab() !== "chat"}>
          <div class="session-dock-events" aria-label={dockTab() === "collaboration" ? "Collaboration events" : "Workflow events"}>
            <For each={(props.events ?? []).filter((event) => dockTab() === "events" || ["TaskAssigned", "ArtifactSubmitted", "ReviewFindingCreated", "TaskAccepted", "BlackboardAccepted"].includes(event.type))}>
              {(event) => <article><time>{new Date(event.createdAt).toLocaleTimeString()}</time><strong>{event.type}</strong><span>{event.nodeID ?? event.runPlanID ?? "session"}</span></article>}
            </For>
            <Show when={!props.events?.length}><p>No Runtime events have been recorded yet.</p></Show>
          </div>
        </Show>
        <div class="session-dock__composer">{props.requestArea}{props.composer}</div>
      </section>
    </section>
      )}
    </>
  )
}

function EmptyPanel(props: { icon: typeof Boxes; title: string }) {
  const Icon = props.icon
  return <div class="session-empty-panel"><Icon aria-hidden="true" /><p>{props.title}</p></div>
}
