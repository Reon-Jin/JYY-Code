import type { Session, SessionStatus } from "@jyycode-ai/sdk/v2/client"
import {
  Bot,
  Boxes,
  CheckCircle2,
  ClipboardList,
  FileCheck2,
  GitPullRequest,
  LayoutDashboard,
  MessageSquare,
  Network,
  Radio,
  Save,
  ShieldAlert,
  X,
} from "lucide-solid"
import { createMemo, createSignal, For, Show, type JSX } from "solid-js"
import { Button } from "../../components/ui/button"
import { tr } from "../../i18n/i18n-context"
import type { ConversationSnapshot } from "../conversation/conversation-state"
import { MessageTimeline } from "../conversation/message-timeline"
import type {
  SessionArtifact,
  SessionAssignment,
  SessionBlackboardCard,
  SessionReviewFinding,
  SessionRunPlan,
  SessionRunPlanPatch,
  SessionRunPlanVersion,
  SessionWorkflowEvent,
} from "./workflow-query"

type WorkspaceTab = "overview" | "plan" | "agents" | "blackboard" | "review" | "deliverables"

const tabs: ReadonlyArray<{ id: WorkspaceTab; label: Parameters<typeof tr>[0]; icon: typeof LayoutDashboard }> = [
  { id: "overview", label: "session-workspace.overview", icon: LayoutDashboard },
  { id: "plan", label: "session-workspace.plan", icon: ClipboardList },
  { id: "agents", label: "session-workspace.agents", icon: Bot },
  { id: "blackboard", label: "session-workspace.blackboard", icon: Boxes },
  { id: "review", label: "session-workspace.review", icon: GitPullRequest },
  { id: "deliverables", label: "session-workspace.deliverables", icon: FileCheck2 },
]

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
  onRetryConversation?: () => void
  requestArea?: JSX.Element
  composer?: JSX.Element
  context?: JSX.Element
}) {
  const [activeTab, setActiveTab] = createSignal<WorkspaceTab>("overview")
  const [dockTab, setDockTab] = createSignal<"chat" | "collaboration" | "events">("chat")
  const active = createMemo(() => tabs.find((tab) => tab.id === activeTab())!)
  const status = createMemo(() => {
    if (props.status?.type === "busy" || props.status?.type === "retry") return "running"
    return planTasks().some((task) => task.status === "failed" || task.status === "blocked") ? "attention" : "ready"
  })
  const planTasks = createMemo(() => props.runPlan?.tasks ?? [])
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
      setPatchError("Task title cannot be empty.")
      return
    }
    if (dependsOn.includes(task.id)) {
      setPatchError("A task cannot depend on itself.")
      return
    }
    setPatching(true)
    setPatchError(undefined)
    try {
      await props.onPatchRunPlan({
        baseVersion: plan.version,
        reason: `Edited task ${task.id} in Session Workspace`,
        operations: [{ type: "update_task", taskID: task.id, title, dependsOn }],
      })
      setEditingTaskID(undefined)
    } catch (error) {
      setPatchError(error instanceof Error ? error.message : "Unable to save this plan change.")
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
        if (next !== "single" && next !== "multi") throw new Error("mode must be either single or multi.")
        mode = next
        continue
      }
      if (line.startsWith("- id:")) {
        currentID = line.slice("- id:".length).trim()
        if (!plan.tasks.some((task) => task.id === currentID)) throw new Error(`Unknown task ID: ${currentID}`)
        continue
      }
      if (!currentID) continue
      if (line.startsWith("title:")) {
        const value = line.slice("title:".length).trim()
        let title = value
        try { title = JSON.parse(value) as string } catch { /* Plain YAML strings are supported too. */ }
        if (!title.trim()) throw new Error(`Task ${currentID} has an empty title.`)
        changes.set(currentID, { ...changes.get(currentID), title })
        continue
      }
      if (line.startsWith("dependsOn:")) {
        const value = line.slice("dependsOn:".length).trim()
        if (!value.startsWith("[") || !value.endsWith("]")) throw new Error(`dependsOn for ${currentID} must use [task-id, ...].`)
        const dependsOn = [...new Set(value.slice(1, -1).split(",").map((id) => id.trim()).filter(Boolean))]
        if (dependsOn.includes(currentID)) throw new Error(`Task ${currentID} cannot depend on itself.`)
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
    if (!operations.length) throw new Error("No editable plan changes were found.")
    return { baseVersion: plan.version, reason: "Edited Run Plan YAML in Session Workspace", operations }
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
      setYamlError(error instanceof Error ? error.message : "Unable to save the YAML plan.")
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
      setModeError(error instanceof Error ? error.message : "Unable to change execution mode.")
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
      setRestoreError(error instanceof Error ? error.message : "Unable to restore this plan version.")
    } finally {
      setRestoreSaving(false)
    }
  }

  function versionDiffSummary(version: SessionRunPlanVersion) {
    const current = props.runPlan
    if (!current || version.version === current.version) return "current snapshot"
    const previous = new Map(version.snapshot.tasks.map((task) => [task.id, task]))
    const currentTasks = new Map(current.tasks.map((task) => [task.id, task]))
    const added = current.tasks.filter((task) => !previous.has(task.id)).length
    const removed = version.snapshot.tasks.filter((task) => !currentTasks.has(task.id)).length
    const changed = current.tasks.filter((task) => {
      const prior = previous.get(task.id)
      return prior && (prior.title !== task.title || prior.dependsOn.join("\u0000") !== task.dependsOn.join("\u0000"))
    }).length
    const parts = [
      ...(current.mode !== version.snapshot.mode ? [`mode ${version.snapshot.mode} → ${current.mode}`] : []),
      ...(added ? [`+${added} task${added === 1 ? "" : "s"}`] : []),
      ...(removed ? [`-${removed} task${removed === 1 ? "" : "s"}`] : []),
      ...(changed ? [`${changed} edited`] : []),
    ]
    return parts.length ? parts.join(" · ") : "same plan structure"
  }

  return (
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
            {tr(`session-workspace.${status()}` as Parameters<typeof tr>[0])}
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
                <span class="session-card__tag" data-tone={status()}>{tr(`session-workspace.${status()}` as Parameters<typeof tr>[0])}</span>
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
              <strong>{props.runPlan ? `${props.runPlan.workflowID} · ${props.runPlan.mode}` : props.multiAgentEnabled ? tr("layout.multi-agent-model") : tr("layout.single-agent-mode")}</strong>
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
            <Show when={props.planVersions && props.planVersions.length > 1}>
              <section class="session-plan-history" aria-label="Run Plan version history">
                <header><span>Version history</span><small>{props.planVersions!.length} snapshots</small></header>
                <p>Snapshots are immutable. Restoring creates a new version and preserves tasks that have already started.</p>
                <div class="session-plan-history__items">
                  <For each={props.planVersions}>
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
            <article class="session-agent-card session-agent-card--main" data-tone="active"><span class="session-agent-card__role">Orchestrator</span><strong>Main Agent</strong><p>{nextStep()?.title ?? "Coordinates the current Session and integrates accepted work."}</p><footer><span>{props.status?.type === "busy" ? "coordinating" : "ready"}</span><small>{props.runPlan ? `Plan v${props.runPlan.version}` : "no plan"}</small></footer></article>
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
  )
}

function EmptyPanel(props: { icon: typeof Boxes; title: string }) {
  const Icon = props.icon
  return <div class="session-empty-panel"><Icon aria-hidden="true" /><p>{props.title}</p></div>
}
