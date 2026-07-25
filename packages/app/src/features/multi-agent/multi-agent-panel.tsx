import { tr } from "../../i18n/i18n-context"
import { createQuery } from "@tanstack/solid-query"
import {
  Bot,
  Bug,
  ChartNoAxesCombined,
  Code,
  Compass,
  FileText,
  FolderSearch,
  Grid2x2,
  Image,
  Map,
  PenLine,
  RefreshCw,
  Search,
  ShieldCheck,
} from "lucide-solid"
import { createMemo, For, Show } from "solid-js"
import { Button } from "../../components/ui/button"
import { InlineError } from "../../components/ui/inline-error"
import { Spinner } from "../../components/ui/spinner"
import { useData } from "../../data/context"
import { errorMessage } from "../projects/project-controller"
import { agentClusterQueryOptions } from "./multi-agent-query"
import {
  projectAgentClusterState,
  type MultiAgentSnapshot,
  type MultiAgentTaskTone,
  type MultiAgentTaskView,
} from "./multi-agent-state"
import { roleAvatar, type MultiAgentRoleAvatar } from "./role-capabilities"
import "./multi-agent.css"

function roleLabel(value: string) {
  const labels: Record<string, string> = {
    general: tr("multi-agent.universal"),
    researcher: tr("multi-agent.research"),
    analyst: tr("multi-agent.role-analyst"),
    writer: tr("multi-agent.role-writer"),
    coder: tr("multi-agent.coding"),
    tester: tr("multi-agent.role-tester"),
    chart: tr("multi-agent.role-chart"),
    pdf: tr("multi-agent.role-pdf"),
    picture_searcher: tr("multi-agent.role-picture-searcher"),
    explore: tr("multi-agent.role-explore"),
    scout: tr("multi-agent.role-scout"),
    reviewer: tr("multi-agent.review"),
    planner: tr("multi-agent.planning"),
  }
  return labels[value.toLowerCase()] ?? value
}

function eventLabel(value: string) {
  const labels: Record<string, string> = {
    planned: tr("multi-agent.planned"),
    queued: tr("multi-agent.already-queued"),
    running: tr("multi-agent.running-2"),
    revising: tr("multi-agent.modifying"),
    submitted: tr("multi-agent.submitted"),
    reviewing: tr("multi-agent.under-review-2"),
    revision_requested: tr("multi-agent.modification-requested"),
    accepted: tr("multi-agent.passed"),
    failed: tr("multi-agent.fail"),
    cancelled: tr("multi-agent.canceled"),
    interrupted: tr("multi-agent.task-status-interrupted"),
  }
  return labels[value.toLowerCase()] ?? value
}

function waveLabel(tone: MultiAgentTaskTone) {
  const labels: Record<MultiAgentTaskTone, string> = {
    queued: "QUEUED",
    running: "ACTIVE",
    review: "VERIFYING",
    done: "VERIFIED",
    failed: "FAILED",
    interrupted: "BLOCKED",
  }
  return labels[tone]
}

function roleMeta(task: MultiAgentTaskView) {
  const status = task.tone === "done" ? "DONE" : task.tone === "interrupted" ? "INTERRUPTED" : task.status.toUpperCase()
  return `[${status}] · ${roleLabel(task.role).toUpperCase()}`
}

function RoleAvatar(props: { role: string }) {
  const avatar = roleAvatar(props.role)
  const icons: Record<MultiAgentRoleAvatar, typeof Bot> = {
    bot: Bot,
    search: Search,
    grid: Grid2x2,
    pen: PenLine,
    code: Code,
    bug: Bug,
    chart: ChartNoAxesCombined,
    file: FileText,
    image: Image,
    folder: FolderSearch,
    compass: Compass,
    shield: ShieldCheck,
    map: Map,
  }
  const Icon = icons[avatar]
  return (
    <span class="multi-agent-task__avatar" data-avatar={avatar} aria-label={roleLabel(props.role)}>
      <Icon aria-hidden="true" />
    </span>
  )
}

function DetailList(props: { label: string; values: readonly string[] }) {
  return (
    <Show when={props.values.length > 0}>
      <div class="multi-agent-task__field">
        <strong>{props.label}</strong>
        <ul>
          <For each={props.values}>{(value) => <li>{value}</li>}</For>
        </ul>
      </div>
    </Show>
  )
}

function TaskDetails(props: { task: MultiAgentTaskView }) {
  return (
    <div class="multi-agent-task__details">
      <dl>
        <div>
          <dt>{tr("multi-agent.role")}</dt>
          <dd>
            <span class="multi-agent-task__role">{roleLabel(props.task.role)}</span>
            <span class="multi-agent-task__capability">{props.task.capabilitySummary}</span>
          </dd>
        </div>
        <div>
          <dt>{tr("multi-agent.active-skills")}</dt>
          <dd class="multi-agent-task__skills">
            <For each={props.task.skillNames}>{(skill) => <span class="multi-agent-skill-chip">{skill}</span>}</For>
          </dd>
        </div>
        <div>
          <dt>{tr("composer.model")}</dt>
          <dd>{props.task.model}</dd>
        </div>
        <div>
          <dt>{tr("multi-agent.state")}</dt>
          <dd>{props.task.statusLabel}</dd>
        </div>
      </dl>
      <Show when={props.task.reviewRound > 0}>
        <p>
          {tr("multi-agent.no")} {props.task.reviewRound} {tr("multi-agent.round-review")}
        </p>
      </Show>
      <Show when={props.task.lastEvent}>
        <div class="multi-agent-task__field">
          <strong>{tr("multi-agent.recent-events")}</strong>
          <p>{eventLabel(props.task.lastEvent!)}</p>
        </div>
      </Show>
      <DetailList label={tr("multi-agent.dependent-tasks")} values={props.task.dependencies} />
      <DetailList label={tr("multi-agent.acceptance-criteria")} values={props.task.acceptanceCriteria} />
      <Show when={props.task.resultSummary}>
        <div class="multi-agent-task__field">
          <strong>{tr("multi-agent.summary-of-results")}</strong>
          <p>{props.task.resultSummary}</p>
        </div>
      </Show>
      <DetailList label={tr("multi-agent.review-question")} values={props.task.reviewIssues} />
      <DetailList label={tr("multi-agent.product")} values={props.task.artifactPaths} />
    </div>
  )
}

export type MultiAgentPanelViewProps = {
  sessionID?: string
  enabled: boolean
  snapshot: MultiAgentSnapshot
  selectedChildSessionID?: string
  loading?: boolean
  error?: string
  onRetry?: () => void
  onOpenChild: (sessionID: string) => void
}

export function MultiAgentPanelView(props: MultiAgentPanelViewProps) {
  return (
    <section class="multi-agent-panel" aria-labelledby="multi-agent-panel-title">
      <header class="multi-agent-panel__header">
        <Bot aria-hidden="true" />
        <h2 id="multi-agent-panel-title">{tr("multi-agent.multi-agent")}</h2>
        <span class="multi-agent-panel__counts">
          {props.snapshot.totalAgents} TASKS · {props.snapshot.doneAgents} DONE · {props.snapshot.runningAgents} ACTIVE ·{" "}
          {props.snapshot.interruptedAgents} INTERRUPTED
        </span>
      </header>

      <Show
        when={!props.loading}
        fallback={
          <p class="multi-agent-panel__loading" role="status" aria-live="polite">
            <Spinner /> {tr("multi-agent.loading-multi-agent-tasks")}
          </p>
        }
      >
        <Show
          when={!props.error}
          fallback={
            <div class="multi-agent-panel__error">
              <InlineError message={props.error!} />
              <Show when={props.onRetry}>
                <Button size="small" variant="secondary" onClick={props.onRetry}>
                  <RefreshCw aria-hidden="true" />
                  {tr("changes.try-again")}
                </Button>
              </Show>
            </div>
          }
        >
          <Show
            when={props.sessionID}
            fallback={<p class="multi-agent-panel__empty">{tr("multi-agent.view-multi-agent-tasks-after-selecting-a-session")}</p>}
          >
            <Show
              when={props.snapshot.tasks.length > 0}
              fallback={
                <p class="multi-agent-panel__empty">
                  {props.enabled
                    ? tr("multi-agent.waiting-for-master-agent-to-generate-plan")
                    : tr("multi-agent.multi-agent-is-not-enabled-for-the-current")}
                </p>
              }
            >
              <div class="multi-agent-panel__body">
                <div class="multi-agent-steps">
                  <For each={props.snapshot.steps}>
                    {(step) => (
                      <section class="multi-agent-step" data-tone={step.tone} aria-labelledby={`multi-agent-step-${step.index}`}>
                        <header>
                          <h3 id={`multi-agent-step-${step.index}`}>
                            <span class="multi-agent-step__marker" aria-hidden="true" />
                            <span>WAVE {String(step.index).padStart(2, "0")} · {waveLabel(step.tone)}</span>
                          </h3>
                          <span class="multi-agent-step__ratio">
                            {step.tasks.filter((task) => task.tone === "done").length}/{step.tasks.length}
                          </span>
                        </header>
                        <ol aria-label={tr("multi-agent.tasks-for-step", { index: step.index })}>
                          <For each={step.tasks}>
                            {(task) => (
                              <li
                                class="multi-agent-task"
                                data-tone={task.tone}
                                data-selected={
                                  task.childSessionID && task.childSessionID === props.selectedChildSessionID ? "true" : "false"
                                }
                              >
                                <details>
                                  <summary>
                                    <RoleAvatar role={task.role} />
                                    <span class="multi-agent-task__content">
                                      <strong>{task.title}</strong>
                                      <small>{roleMeta(task)}</small>
                                    </span>
                                    <Show when={task.childSessionID}>
                                      {(childSessionID) => (
                                        <Button
                                          size="small"
                                          variant="ghost"
                                          aria-label={tr("multi-agent.review-task", { title: task.title })}
                                          onClick={(event) => {
                                            event.preventDefault()
                                            event.stopPropagation()
                                            props.onOpenChild(childSessionID())
                                          }}
                                        >
                                          {tr("multi-agent.review")}
                                        </Button>
                                      )}
                                    </Show>
                                    <Show when={!task.childSessionID}>
                                      <span class="multi-agent-task__matrix">{task.statusLabel}</span>
                                    </Show>
                                  </summary>
                                  <TaskDetails task={task} />
                                </details>
                              </li>
                            )}
                          </For>
                        </ol>
                      </section>
                    )}
                  </For>
                </div>

                <footer class="multi-agent-legend" aria-label="Task status legend">
                  <span data-tone="queued"><i /> QUEUED</span>
                  <span data-tone="running"><i /> ACTIVE</span>
                  <span data-tone="done"><i /> DONE</span>
                  <span data-tone="interrupted"><i /> INTERRUPTED</span>
                </footer>
              </div>
            </Show>
          </Show>
        </Show>
      </Show>
    </section>
  )
}

export function MultiAgentPanel(props: {
  directory: string
  sessionID?: string
  enabled: boolean
  selectedChildSessionID?: string
  onOpenChild: (sessionID: string) => void
}) {
  const data = useData()
  const query = createQuery(
    () => ({
      ...agentClusterQueryOptions({
        client: data.client(),
        directory: props.directory,
        sessionID: props.sessionID ?? "",
      }),
      enabled: Boolean(props.sessionID),
    }),
    data.queryClient,
  )
  const snapshot = createMemo(() => projectAgentClusterState(query.data ?? { tasks: [] }))

  return (
    <MultiAgentPanelView
      sessionID={props.sessionID}
      enabled={props.enabled}
      snapshot={snapshot()}
      selectedChildSessionID={props.selectedChildSessionID}
      loading={Boolean(props.sessionID) && query.isPending}
      error={query.error ? errorMessage(query.error, tr("multi-agent.unable-to-load-multi-agent-task")) : undefined}
      onRetry={() => void query.refetch()}
      onOpenChild={props.onOpenChild}
    />
  )
}
