import type { TuiPlugin, TuiPluginApi } from "@jyycode-ai/plugin/tui"
import type { InternalTuiPlugin } from "../../plugin/internal"
import { createMemo, For, Show, createSignal } from "solid-js"
import { TodoItem } from "../../component/todo-item"
import { agentClusterSnapshot, type AgentClusterTaskStatus } from "../../routes/session/agent-cluster-state"
import { MailSession } from "@/communication/mail-session"

const id = "internal:sidebar-todo"

function statusMarker(status: AgentClusterTaskStatus): string {
  if (status === "done") return "✓"
  if (status === "failed") return "✗"
  if (status === "running") return "•"
  return " "
}

function statusColor(status: AgentClusterTaskStatus, theme: TuiPluginApi["theme"]["current"]) {
  if (status === "failed") return theme.error
  if (status === "running") return theme.warning
  if (status === "done") return theme.success
  return theme.textMuted
}

function View(props: { api: TuiPluginApi; session_id: string }) {
  const [open, setOpen] = createSignal(true)
  const theme = () => props.api.theme.current
  const list = createMemo(() => props.api.state.session.todo(props.session_id))
  const session = createMemo(() => props.api.state.session.get(props.session_id))

  const disabled = createMemo(() => {
    const current = session()
    if (!current) return false
    if (current.parentID) return true
    if (MailSession.isMailSessionTitle(current.title)) return true
    if (current.agent === "mail") return true
    return current.path === "mail"
  })
  const multiAgent = createMemo(
    () => !disabled() && (session()?.multiAgent ?? props.api.state.config.agent_cluster?.default_on) === true,
  )

  const snapshot = createMemo(() => {
    if (!multiAgent()) return undefined
    return agentClusterSnapshot({
      sessionID: props.session_id,
      enabled: multiAgent(),
      disabled: disabled(),
      cluster: props.api.state.session.agentCluster(props.session_id),
      messages: (sessionID) => props.api.state.session.messages(sessionID),
      parts: (messageID) => props.api.state.part(messageID),
      sessionStatus: (sessionID) => props.api.state.session.status(sessionID),
    })
  })

  const hasPlan = createMemo(() => (snapshot()?.plan?.tasks?.length ?? 0) > 0)
  const hasTodoItems = createMemo(() => list().length > 0 && list().some((item) => item.status !== "completed"))
  const show = createMemo(() => {
    if (multiAgent()) return true
    return hasTodoItems()
  })

  return (
    <Show when={show()}>
      <box>
        <box flexDirection="row" gap={1}>
          <text fg={theme().text}>
            <b>Todo</b>
          </text>
        </box>

        {/* Multi-agent mode: plan steps with sub-agent tasks */}
        <Show when={multiAgent() && hasPlan()}>
          <For each={snapshot()!.steps}>
            {(step) => (
              <box paddingLeft={1}>
                <text fg={statusColor(step.status, theme())}>
                  Step {step.index}: {step.agents} agent{step.agents === 1 ? "" : "s"} · {step.done}/{step.agents} done
                </text>
                <For each={step.tasks}>
                  {(task) => (
                    <box paddingLeft={2} flexDirection="row" gap={1}>
                      <text fg={statusColor(task.status, theme())} flexShrink={0}>
                        [{statusMarker(task.status)}]
                      </text>
                      <text fg={theme().textMuted} flexShrink={0}>
                        [{task.role}]
                      </text>
                      <text fg={statusColor(task.status, theme())} wrapMode="word" flexGrow={1}>
                        {task.title}
                      </text>
                    </box>
                  )}
                </For>
              </box>
            )}
          </For>
        </Show>

        {/* Multi-agent mode: dispatched but no plan parsed yet — show raw rows */}
        <Show when={multiAgent() && !hasPlan() && (snapshot()?.rows.length ?? 0) > 0}>
          <For each={snapshot()!.rows}>
            {(row) => (
              <box flexDirection="row" gap={1}>
                <text fg={statusColor(row.status, theme())} flexShrink={0}>
                  [{statusMarker(row.status)}]
                </text>
                <text fg={theme().textMuted}>{row.task || `Agent ${row.index}`}</text>
              </box>
            )}
          </For>
        </Show>

        {/* Single-agent mode: regular TodoWrite items */}
        <Show when={!multiAgent()}>
          <Show when={list().length > 2}>
            <box flexDirection="row" gap={1} onMouseDown={() => setOpen((x) => !x)}>
              <text fg={theme().text}>{open() ? "▼" : "▶"}</text>
            </box>
          </Show>
          <Show when={list().length <= 2 || open()}>
            <For each={list()}>{(item) => <TodoItem status={item.status} content={item.content} />}</For>
          </Show>
        </Show>

        {/* Multi-agent mode: plan hasn't arrived yet */}
        <Show when={multiAgent() && !hasPlan() && (snapshot()?.rows.length ?? 0) === 0}>
          <text fg={theme().textMuted}>Planning...</text>
        </Show>
      </box>
    </Show>
  )
}

const tui: TuiPlugin = async (api) => {
  api.slots.register({
    order: 400,
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
