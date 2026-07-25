import { tr } from "../../i18n/i18n-context"
import { createQuery } from "@tanstack/solid-query"
import { Bot, RefreshCw } from "lucide-solid"
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
import "./multi-agent.css"

function toneLabel(tone: MultiAgentTaskTone) {
  const labels: Record<MultiAgentTaskTone, string> = {
    queued: tr("multi-agent.waiting"),
    running: tr("multi-agent.running"),
    review: tr("multi-agent.under-review"),
    done: tr("conversation.completed"),
    failed: tr("multi-agent.fail"),
    interrupted: tr("multi-agent.task-status-interrupted"),
  }
  return labels[tone]
}

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
          {props.snapshot.runningAgents} {tr("multi-agent.run")} {props.snapshot.doneAgents} {tr("multi-agent.finish")}{" "}
          {props.snapshot.failedAgents} {tr("multi-agent.fail")}
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
            fallback={
              <p class="multi-agent-panel__empty">
                {tr("multi-agent.view-multi-agent-tasks-after-selecting-a-session")}
              </p>
            }
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
              <>
                <div class="multi-agent-panel__body">
                  <div class="multi-agent-summary">
                    <span class="multi-agent-summary__status">
                      {props.snapshot.runningAgents} {tr("multi-agent.running")}
                    </span>
                    <Show
                      when={props.snapshot.totalAgents > 0}
                      fallback={
                        <p class="multi-agent-panel__empty">
                          {tr("multi-agent.waiting-for-master-agent-to-generate-plan")}
                        </p>
                      }
                    >
                      <p class="multi-agent-summary__counts">
                        {tr("multi-agent.step")} {props.snapshot.currentStep}/{props.snapshot.totalSteps} ·{" "}
                        {props.snapshot.completedSteps} {tr("multi-agent.finish-2")}
                      </p>
                    </Show>
                  </div>

                  <div class="multi-agent-steps">
                    <For each={props.snapshot.steps}>
                      {(step) => (
                        <section
                          class="multi-agent-step"
                          data-collapsed={step.collapsed}
                          aria-labelledby={`multi-agent-step-${step.index}`}
                        >
                          <header>
                            <h3 id={`multi-agent-step-${step.index}`}>
                              {tr("multi-agent.step")} {step.index}
                            </h3>
                            <span data-tone={step.tone}>{toneLabel(step.tone)}</span>
                          </header>
                          <ol aria-label={tr("multi-agent.tasks-for-step", { index: step.index })}>
                            <For each={step.tasks}>
                              {(task) => (
                                <li
                                  class="multi-agent-task"
                                  data-tone={task.tone}
                                  data-selected={
                                    task.childSessionID && task.childSessionID === props.selectedChildSessionID
                                      ? "true"
                                      : "false"
                                  }
                                >
                                  <details>
                                    <summary>
                                      <span>{task.title}</span>
                                      <span class="multi-agent-task__matrix">{task.statusLabel}</span>
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
                </div>
              </>
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
