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
  queued: "等待中",
  running: "运行中",
  review: "复核中",
  done: "已完成",
  failed: "失败",
}

function roleLabel(value: string) {
  const labels: Record<string, string> = {
    general: "通用",
    researcher: "调研",
    coder: "编码",
    reviewer: "审阅",
    planner: "规划",
  }
  return labels[value.toLowerCase()] ?? value
}

function eventLabel(value: string) {
  const labels: Record<string, string> = {
    planned: "已规划",
    queued: "已进入队列",
    running: "正在运行",
    revising: "正在修改",
    submitted: "已提交",
    reviewing: "正在复核",
    revision_requested: "已要求修改",
    accepted: "已通过",
    failed: "失败",
    cancelled: "已取消",
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
          <dt>角色</dt>
          <dd>{roleLabel(props.task.role)}</dd>
        </div>
        <div>
          <dt>模型</dt>
          <dd>{props.task.model}</dd>
        </div>
        <div>
          <dt>状态</dt>
          <dd>{props.task.statusLabel}</dd>
        </div>
      </dl>
      <Show when={props.task.reviewRound > 0}>
        <p>第 {props.task.reviewRound} 轮复核</p>
      </Show>
      <Show when={props.task.lastEvent}>
        <div class="multi-agent-task__field">
          <strong>最近事件</strong>
          <p>{eventLabel(props.task.lastEvent!)}</p>
        </div>
      </Show>
      <DetailList label="依赖任务" values={props.task.dependencies} />
      <DetailList label="验收标准" values={props.task.acceptanceCriteria} />
      <Show when={props.task.resultSummary}>
        <div class="multi-agent-task__field">
          <strong>结果摘要</strong>
          <p>{props.task.resultSummary}</p>
        </div>
      </Show>
      <DetailList label="复核问题" values={props.task.reviewIssues} />
      <DetailList label="产物" values={props.task.artifactPaths} />
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
        <h2 id="multi-agent-panel-title">多智能体</h2>
        <span class="multi-agent-panel__counts">
          {props.snapshot.runningAgents} 运行 · {props.snapshot.doneAgents} 完成 · {props.snapshot.failedAgents} 失败
        </span>
      </header>

      <Show
        when={!props.loading}
        fallback={
          <p class="multi-agent-panel__loading" role="status" aria-live="polite">
            <Spinner /> 正在加载多智能体任务
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
          <Show when={props.sessionID} fallback={<p class="multi-agent-panel__empty">选择会话后查看多智能体任务</p>}>
            <Show
              when={run()}
              fallback={
                <p class="multi-agent-panel__empty">
                  {props.enabled ? "正在等待主智能体生成计划" : "当前会话未启用多智能体"}
                </p>
              }
            >
              {(latest) => (
                <div class="multi-agent-panel__body">
                  <div class="multi-agent-summary">
                    <span class="multi-agent-summary__status" data-status={latest().status}>
                      {latest().statusLabel}
                    </span>
                    <Show
                      when={props.snapshot.totalAgents > 0}
                      fallback={<p class="multi-agent-panel__empty">正在等待主智能体生成计划</p>}
                    >
                      <div
                        class="multi-agent-progress"
                        role="progressbar"
                        aria-label="多智能体进度"
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
                        步骤 {props.snapshot.currentStep}/{props.snapshot.totalSteps} · {props.snapshot.completedSteps} 完成
                      </p>
                    </Show>
                  </div>

                  <div class="multi-agent-steps">
                    <For each={props.snapshot.steps}>
                      {(step) => (
                        <section class="multi-agent-step" aria-labelledby={`multi-agent-step-${step.index}`}>
                          <header>
                            <h3 id={`multi-agent-step-${step.index}`}>步骤 {step.index}</h3>
                            <span data-tone={step.tone}>{toneLabels[step.tone]}</span>
                          </header>
                          <ol aria-label={`步骤 ${step.index} 的任务`}>
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
                                      <Show when={task.childSessionID}>
                                        {(childSessionID) => (
                                          <Button
                                            size="small"
                                            variant="ghost"
                                            aria-label={`审阅：${task.title}`}
                                            onClick={(event) => {
                                              event.preventDefault()
                                              event.stopPropagation()
                                              props.onOpenChild(childSessionID())
                                            }}
                                          >
                                            审阅
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
      error={query.error ? errorMessage(query.error, "无法加载多智能体任务") : undefined}
      onRetry={() => void query.refetch()}
      onOpenChild={props.onOpenChild}
    />
  )
}
