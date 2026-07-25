import type { TuiPlugin, TuiPluginApi } from "@jyycode-ai/plugin/tui"
import type { InternalTuiPlugin } from "../../plugin/internal"
import { createMemo, For, Show } from "solid-js"
import { Locale } from "@/util/locale"
import { agentClusterSnapshot, type AgentClusterTaskStatus } from "../../routes/session/agent-cluster-state"
import { MailSession } from "@/communication/mail-session"
import { ProgressBar } from "../../component/progress-bar"

const id = "internal:sidebar-multi-agent"

function marker(status: AgentClusterTaskStatus) {
  if (status === "done") return "[x]"
  if (status === "failed") return "[!]"
  if (status === "running") return "[>]"
  return "[ ]"
}

function statusColor(status: AgentClusterTaskStatus, theme: TuiPluginApi["theme"]["current"]) {
  if (status === "failed") return theme.error
  if (status === "running") return theme.warning
  if (status === "done") return theme.success
  return theme.textMuted
}

function View(props: { api: TuiPluginApi; session_id: string }) {
  const theme = () => props.api.theme.current
  const session = createMemo(() => props.api.state.session.get(props.session_id))
  const disabled = createMemo(() => {
    const current = session()
    if (!current) return false
    if (current.parentID) return true
    if (MailSession.isMailSessionTitle(current.title)) return true
    if (current.agent === "mail") return true
    return current.path === "mail"
  })
  const enabled = createMemo(
    () => !disabled() && (session()?.multiAgent ?? props.api.state.config.agent_cluster?.default_on) === true,
  )
  const snapshot = createMemo(() =>
    agentClusterSnapshot({
      sessionID: props.session_id,
      enabled: enabled(),
      disabled: disabled(),
      cluster: props.api.state.session.agentCluster(props.session_id),
      messages: (sessionID) => props.api.state.session.messages(sessionID),
      parts: (messageID) => props.api.state.part(messageID),
      sessionStatus: (sessionID) => props.api.state.session.status(sessionID),
    }),
  )

  return (
    <Show when={snapshot().plan || snapshot().rows.length > 0 || enabled()}>
      <box>
        <text fg={theme().text}>
          <b>Multi-Agent Plan</b>
        </text>
        <text fg={theme().textMuted}>
          {snapshot().totalSteps || 0} steps · current {snapshot().currentStep ?? "-"} · completed{" "}
          {snapshot().completedSteps}/{snapshot().totalSteps || 0}
        </text>
        <Show when={snapshot().totalSteps && snapshot().totalSteps > 0}>
          <ProgressBar
            ratio={snapshot().totalSteps ? snapshot().completedSteps / snapshot().totalSteps : 0}
            width={36}
          />
        </Show>
        <text fg={theme().textMuted}>
          agents {snapshot().totalAgents} · running {snapshot().runningAgents} · done {snapshot().doneAgents} · failed{" "}
          {snapshot().failedAgents}
        </text>
        <Show when={snapshot().plan?.goal}>
          {(goal) => <text fg={theme().textMuted}>{Locale.truncate(goal(), 36)}</text>}
        </Show>
        <Show
          when={snapshot().steps.length > 0}
          fallback={<text fg={theme().textMuted}>{enabled() ? "Waiting for plan..." : "Multi-Agent is off"}</text>}
        >
          <box paddingTop={1}>
            <For each={snapshot().steps}>
              {(step) => (
                <box>
                  <text fg={statusColor(step.status, theme())}>
                    Step {step.index}: {step.agents} agent{step.agents === 1 ? "" : "s"} · {step.done}/{step.agents}{" "}
                    done
                  </text>
                  <For each={step.tasks}>
                    {(task) => (
                      <text fg={statusColor(task.status, theme())}>
                        {marker(task.status)} {Locale.titlecase(task.role)} ·{" "}
                        {Locale.truncate(task.skillNames?.join(", ") ?? task.skillName ?? "role-skill", 22)}{" "}
                        {Locale.truncate(task.title, 29)}
                      </text>
                    )}
                  </For>
                </box>
              )}
            </For>
          </box>
        </Show>
      </box>
    </Show>
  )
}

const tui: TuiPlugin = async (api) => {
  api.slots.register({
    order: 350,
    slots: {
      sidebar_content(_ctx, props) {
        return <View api={api} session_id={props.session_id} />
      },
    },
  })
}

const plugin: InternalTuiPlugin = {
  id,
  tui,
}

export default plugin
