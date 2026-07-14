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

const toneLabels: Record<MultiAgentTaskTone, string> = {
  queued: "Queued",
  running: "Running",
  review: "Review",
  done: "Done",
  failed: "Failed",
}

function capitalize(value: string) {
  return value ? value.charAt(0).toUpperCase() + value.slice(1) : value
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
          <dt>Role</dt>
          <dd>{capitalize(props.task.role)}</dd>
        </div>
        <div>
          <dt>Model</dt>
          <dd>{props.task.model}</dd>
        </div>
        <div>
          <dt>Status</dt>
          <dd>{props.task.statusLabel}</dd>
        </div>
      </dl>
      <Show when={props.task.reviewRound > 0}>
        <p>第 {props.task.reviewRound} 轮复核</p>
      </Show>
      <Show when={props.task.lastEvent}>
        <div class="multi-agent-task__field">
          <strong>Last event</strong>
          <p>{props.task.lastEvent}</p>
        </div>
      </Show>
      <DetailList label="Dependencies" values={props.task.dependencies} />
      <DetailList label="Acceptance criteria" values={props.task.acceptanceCriteria} />
      <Show when={props.task.resultSummary}>
        <div class="multi-agent-task__field">
          <strong>Result summary</strong>
          <p>{props.task.resultSummary}</p>
        </div>
      </Show>
      <DetailList label="Review issues" values={props.task.reviewIssues} />
      <DetailList label="Artifacts" values={props.task.artifactPaths} />
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
  const run = () => props.snapshot.latestRun

  return (
    <section class="multi-agent-panel" aria-labelledby="multi-agent-panel-title">
      <header class="multi-agent-panel__header">
        <Bot aria-hidden="true" />
        <h2 id="multi-agent-panel-title">Multi-Agent</h2>
        <span class="multi-agent-panel__counts">
          {props.snapshot.runningAgents} 运行 · {props.snapshot.doneAgents} 完成 · {props.snapshot.failedAgents} 失败
        </span>
      </header>

      <Show
        when={!props.loading}
        fallback={
          <p class="multi-agent-panel__loading" role="status" aria-live="polite">
            <Spinner /> 正在加载 Multi-Agent
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
                  重试
                </Button>
              </Show>
            </div>
          }
        >
          <Show when={props.sessionID} fallback={<p class="multi-agent-panel__empty">选择 Session 后查看 Multi-Agent</p>}>
            <Show
              when={run()}
              fallback={
                <p class="multi-agent-panel__empty">
                  {props.enabled ? "正在等待主 Agent 生成计划" : "当前 Session 未启用 Multi-Agent"}
                </p>
              }
            >
              {(latest) => (
                <div class="multi-agent-panel__body">
                  <div class="multi-agent-summary">
                    <span class="multi-agent-summary__status" data-status={latest().status}>
                      {latest().statusLabel}
                    </span>
                    <p>{latest().goal}</p>
                    <Show
                      when={props.snapshot.totalAgents > 0}
                      fallback={<p class="multi-agent-panel__empty">正在等待主 Agent 生成计划</p>}
                    >
                      <div
                        class="multi-agent-progress"
                        role="progressbar"
                        aria-label="Multi-Agent progress"
                        aria-valuemin="0"
                        aria-valuemax={props.snapshot.totalAgents}
                        aria-valuenow={props.snapshot.doneAgents}
                      >
                        <span
                          style={{
                            width: `${Math.round((props.snapshot.doneAgents / props.snapshot.totalAgents) * 100)}%`,
                          }}
                        />
                      </div>
                      <p class="multi-agent-summary__counts">
                        Step {props.snapshot.currentStep}/{props.snapshot.totalSteps} · {props.snapshot.completedSteps} 完成
                      </p>
                    </Show>
                  </div>

                  <div class="multi-agent-steps">
                    <For each={props.snapshot.steps}>
                      {(step) => (
                        <section class="multi-agent-step" aria-labelledby={`multi-agent-step-${step.index}`}>
                          <header>
                            <h3 id={`multi-agent-step-${step.index}`}>Step {step.index}</h3>
                            <span data-tone={step.tone}>{toneLabels[step.tone]}</span>
                          </header>
                          <ol aria-label={`Step ${step.index} tasks`}>
                            <For each={step.tasks}>
                              {(task) => (
                                <li
                                  class="multi-agent-task"
                                  data-tone={task.tone}
                                  data-selected={task.childSessionID === props.selectedChildSessionID ? "true" : "false"}
                                >
                                  <details>
                                    <summary>
                                      <span>{task.title}</span>
                                      <small>{task.statusLabel}</small>
                                    </summary>
                                    <TaskDetails task={task} />
                                  </details>
                                  <Show when={task.childSessionID}>
                                    {(childSessionID) => (
                                      <Button
                                        size="small"
                                        variant="ghost"
                                        aria-label={`打开子 Agent：${task.title}`}
                                        onClick={() => props.onOpenChild(childSessionID())}
                                      >
                                        打开子 Agent
                                      </Button>
                                    )}
                                  </Show>
                                </li>
                              )}
                            </For>
                          </ol>
                        </section>
                      )}
                    </For>
                  </div>
                </div>
              )}
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
  const snapshot = createMemo(() => projectAgentClusterState(query.data ?? { runs: [], tasks: [] }))

  return (
    <MultiAgentPanelView
      sessionID={props.sessionID}
      enabled={props.enabled}
      snapshot={snapshot()}
      selectedChildSessionID={props.selectedChildSessionID}
      loading={Boolean(props.sessionID) && query.isPending}
      error={query.error ? errorMessage(query.error, "无法加载 Multi-Agent") : undefined}
      onRetry={() => void query.refetch()}
      onOpenChild={props.onOpenChild}
    />
  )
}
