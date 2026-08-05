import { tr } from "../../i18n/i18n-context"
import { Bot, CircleHelp, RefreshCw } from "lucide-solid"
import { createEffect, createMemo, createSignal, For, Index, onCleanup, onMount, Show } from "solid-js"
import { Button } from "../../components/ui/button"
import { BorderBeam } from "../../components/ui/border-beam"
import { InlineError } from "../../components/ui/inline-error"
import { ThinkingOrb } from "../../components/ui/thinking-orb"
import { type MultiAgentSnapshot, type MultiAgentTaskTone, type MultiAgentTaskView } from "../plan/plan-state"
import { planRoleDescription, planRoleLabel } from "../plan/plan-role-presentation"
import { SubagentAvatar } from "../subagents/subagent-avatar-catalog"
import "./multi-agent.css"

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
    queued: tr("multi-agent.wave-status-queued"),
    running: tr("multi-agent.wave-status-running"),
    review: tr("multi-agent.wave-status-review"),
    done: tr("multi-agent.wave-status-done"),
    failed: tr("multi-agent.wave-status-failed"),
    interrupted: tr("multi-agent.wave-status-interrupted"),
  }
  return labels[tone]
}

function candidatePhaseLabel(phase: NonNullable<MultiAgentSnapshot["steps"][number]["candidate"]>["phase"]) {
  return tr(`multi-agent.candidate-phase-${phase}` as Parameters<typeof tr>[0])
}

function roleMeta(task: MultiAgentTaskView) {
  const status =
    task.tone === "done"
      ? tr("multi-agent.count-done")
      : task.tone === "interrupted"
        ? tr("multi-agent.count-interrupted")
        : task.statusLabel
  return `[${status}] · ${planRoleLabel(task.role).toUpperCase()}`
}

function RoleAvatar(props: { role: MultiAgentTaskView["role"] }) {
  return (
    <span
      class="multi-agent-task__avatar"
      data-avatar={props.role?.avatar ?? "unassigned"}
      aria-label={planRoleLabel(props.role)}
    >
      {props.role ? <SubagentAvatar id={props.role.avatar} /> : <CircleHelp aria-hidden="true" />}
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
            <span class="multi-agent-task__role">{planRoleLabel(props.task.role)}</span>
            <span class="multi-agent-task__role-description">{planRoleDescription(props.task.role)}</span>
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
  title?: string
  progressLabel?: string
  waitingForPlanMessage?: string
  noPlanMessage?: string
  loading?: boolean
  error?: string
  onRetry?: () => void
  onOpenChild: (sessionID: string) => void
}

type PanelViewState = {
  collapsedSteps: ReadonlySet<number>
  scrollTop: number
}

// The plan view can survive a child-session navigation by being recreated.
// Keep interaction state outside the component and key it by the root plan,
// so changing the reviewed child does not expand every wave or jump to top.
const panelViewState = new Map<string, PanelViewState>()

function panelStateKey(sessionID: string | undefined) {
  return sessionID ?? "__no-plan__"
}

export function MultiAgentPanelView(props: MultiAgentPanelViewProps) {
  let body: HTMLDivElement | undefined
  let activeStateKey = panelStateKey(props.sessionID)
  const [collapsedSteps, setCollapsedSteps] = createSignal<ReadonlySet<number>>(
    new Set(panelViewState.get(activeStateKey)?.collapsedSteps ?? []),
  )
  const completionPercent = () =>
    props.snapshot.totalAgents > 0 ? Math.round((props.snapshot.doneAgents / props.snapshot.totalAgents) * 100) : 0

  function savePanelState() {
    panelViewState.set(activeStateKey, {
      collapsedSteps: new Set(collapsedSteps()),
      scrollTop: body?.scrollTop ?? panelViewState.get(activeStateKey)?.scrollTop ?? 0,
    })
  }

  function restorePanelState() {
    const saved = panelViewState.get(activeStateKey)
    setCollapsedSteps(new Set(saved?.collapsedSteps ?? []))
    queueMicrotask(() => {
      if (body && saved) body.scrollTop = saved.scrollTop
    })
  }

  onMount(restorePanelState)
  onCleanup(savePanelState)

  createEffect(() => {
    const nextKey = panelStateKey(props.sessionID)
    if (nextKey === activeStateKey) return
    savePanelState()
    activeStateKey = nextKey
    restorePanelState()
  })

  function toggleStep(index: number) {
    setCollapsedSteps((current) => {
      const next = new Set(current)
      if (next.has(index)) next.delete(index)
      else next.add(index)
      panelViewState.set(activeStateKey, {
        collapsedSteps: next,
        scrollTop: body?.scrollTop ?? panelViewState.get(activeStateKey)?.scrollTop ?? 0,
      })
      return next
    })
  }

  return (
    <section class="multi-agent-panel" aria-labelledby="multi-agent-panel-title">
      <header class="multi-agent-panel__header">
        <Bot aria-hidden="true" />
        <h2 id="multi-agent-panel-title">{props.title ?? tr("multi-agent.multi-agent")}</h2>
        <span class="multi-agent-panel__counts">
          {props.snapshot.totalAgents} {tr("multi-agent.count-tasks")} · {props.snapshot.doneAgents}{" "}
          {tr("multi-agent.count-done")} · {props.snapshot.runningAgents} {tr("multi-agent.count-active")} ·{" "}
          {props.snapshot.interruptedAgents} {tr("multi-agent.count-interrupted")}
        </span>
      </header>
      <div class="multi-agent-panel__progress-row">
        <progress
          class="multi-agent-panel__progress"
          aria-label={props.progressLabel ?? tr("multi-agent.multi-agent-progress")}
          aria-valuemin={0}
          aria-valuemax={Math.max(props.snapshot.totalAgents, 1)}
          aria-valuenow={props.snapshot.doneAgents}
          max={Math.max(props.snapshot.totalAgents, 1)}
          value={props.snapshot.doneAgents}
        />
        <span class="multi-agent-panel__progress-value" aria-hidden="true">
          {completionPercent()}%
        </span>
      </div>

      <Show
        when={!props.loading}
        fallback={
          <p class="multi-agent-panel__loading" role="status" aria-live="polite">
            <ThinkingOrb state="working" size={20} theme="light" aria-hidden="true" />{" "}
            {tr("multi-agent.loading-multi-agent-tasks")}
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
                    ? (props.waitingForPlanMessage ?? tr("multi-agent.waiting-for-master-agent-to-generate-plan"))
                    : (props.noPlanMessage ?? tr("multi-agent.multi-agent-is-not-enabled-for-the-current"))}
                </p>
              }
            >
              <div class="multi-agent-panel__body" ref={body} onScroll={savePanelState}>
                <div class="multi-agent-steps">
                  <Index each={props.snapshot.steps}>
                    {(item) => {
                      const wave = () => item()
                      const step = {
                        get index() {
                          return wave().index
                        },
                        get title() {
                          return wave().title
                        },
                        get tone() {
                          return wave().tone
                        },
                      }
                      const collapsed = () => collapsedSteps().has(wave().index)
                      const taskListID = () => `multi-agent-step-tasks-${wave().index}`
                      return (
                        <section
                          class="multi-agent-step"
                          data-tone={wave().tone}
                          data-collapsed={collapsed()}
                          aria-labelledby={`multi-agent-step-${wave().index}`}
                        >
                          <header>
                            <h3 id={`multi-agent-step-${wave().index}`}>
                              <span class="multi-agent-step__marker" aria-hidden="true" />
                              <span>
                                {tr("multi-agent.wave", {
                                  index: String(step.index).padStart(2, "0"),
                                  status: waveLabel(step.tone),
                                })}
                              </span>
                              <span class="multi-agent-step__title">— {step.title}</span>
                            </h3>
                            <Show when={wave().candidate}>
                              {(candidate) => (
                                <span class="multi-agent-step__candidate" data-candidate-phase={candidate().phase}>
                                  {tr("multi-agent.candidate-discussion")} · {candidatePhaseLabel(candidate().phase)} ·{" "}
                                  {candidate().ready}/{candidate().total}
                                </span>
                              )}
                            </Show>
                            <div class="multi-agent-step__actions">
                              <span class="multi-agent-step__ratio">
                                {wave().tasks.filter((task) => task.tone === "done").length}/{wave().tasks.length}
                              </span>
                              <button
                                class="multi-agent-step__toggle"
                                type="button"
                                data-expanded={!collapsed()}
                                aria-controls={taskListID()}
                                aria-expanded={!collapsed()}
                                aria-label={tr("multi-agent.toggle-wave", { index: wave().index })}
                                onClick={() => toggleStep(wave().index)}
                              >
                                <span aria-hidden="true">&gt;</span>
                              </button>
                            </div>
                          </header>
                          <Show when={!collapsed()}>
                            <Show when={wave().candidate?.selection}>
                              {(selection) => (
                                <aside
                                  class="multi-agent-candidate-selection"
                                  aria-label={tr("multi-agent.candidate-selection")}
                                >
                                  <strong>{tr("multi-agent.candidate-selected-task")}</strong>
                                  <span>{selection().selectedTaskID}</span>
                                  <strong>{tr("multi-agent.candidate-contributions")}</strong>
                                  <span>
                                    {selection().contributingTaskIDs.join(", ") || tr("multi-agent.candidate-none")}
                                  </span>
                                  <strong>{tr("multi-agent.candidate-synthesis")}</strong>
                                  <span>{selection().synthesisArtifact}</span>
                                </aside>
                              )}
                            </Show>
                            <ol
                              id={taskListID()}
                              aria-label={tr("multi-agent.tasks-for-step", { index: wave().index })}
                            >
                              <Index each={wave().tasks}>
                                {(task) => (
                                  <li
                                    class="multi-agent-task"
                                    data-tone={task().tone}
                                    data-selected={
                                      task().childSessionID && task().childSessionID === props.selectedChildSessionID
                                        ? "true"
                                        : "false"
                                    }
                                  >
                                    <BorderBeam
                                      class="multi-agent-task__beam"
                                      colorVariant="jyy"
                                      theme="light"
                                      borderRadius={4}
                                      active={task().tone === "running"}
                                    >
                                      <details>
                                        <summary>
                                          <RoleAvatar role={task().role} />
                                          <span class="multi-agent-task__content">
                                            <strong>{task().title}</strong>
                                            <small>{roleMeta(task())}</small>
                                          </span>
                                          <Show when={task().childSessionID}>
                                            {(childSessionID) => (
                                              <Button
                                                size="small"
                                                variant="ghost"
                                                aria-label={tr("multi-agent.review-task", { title: task().title })}
                                                onClick={(event) => {
                                                  event.preventDefault()
                                                  event.stopPropagation()
                                                  savePanelState()
                                                  props.onOpenChild(childSessionID())
                                                }}
                                              >
                                                {tr("multi-agent.review")}
                                              </Button>
                                            )}
                                          </Show>
                                          <Show when={!task().childSessionID}>
                                            <span class="multi-agent-task__matrix">{task().statusLabel}</span>
                                          </Show>
                                        </summary>
                                        <TaskDetails task={task()} />
                                      </details>
                                    </BorderBeam>
                                  </li>
                                )}
                              </Index>
                            </ol>
                          </Show>
                        </section>
                      )
                    }}
                  </Index>
                </div>

                <footer class="multi-agent-legend" aria-label={tr("multi-agent.task-status-legend")}>
                  <span data-tone="queued">
                    <i /> {tr("multi-agent.wave-status-queued")}
                  </span>
                  <span data-tone="running">
                    <i /> {tr("multi-agent.count-active")}
                  </span>
                  <span data-tone="done">
                    <i /> {tr("multi-agent.count-done")}
                  </span>
                  <span data-tone="interrupted">
                    <i /> {tr("multi-agent.count-interrupted")}
                  </span>
                </footer>
              </div>
            </Show>
          </Show>
        </Show>
      </Show>
    </section>
  )
}
