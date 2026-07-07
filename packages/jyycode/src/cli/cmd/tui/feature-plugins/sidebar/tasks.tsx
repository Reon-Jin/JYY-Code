import type { TuiPlugin, TuiPluginApi } from "@jyycode-ai/plugin/tui"
import type { InternalTuiPlugin } from "../../plugin/internal"
import { createMemo, createSignal, For, Show } from "solid-js"
import { TaskItem, taskStatusRank } from "../../component/task-item"
import type { AgentClusterTaskStatus } from "../../routes/session/agent-cluster-state"

const id = "internal:sidebar-tasks"
const doneLimit = 3

export type TaskRow = {
  id: string
  status: AgentClusterTaskStatus
  title: string
  role?: string
}

function clusterTaskStatus(status: string): AgentClusterTaskStatus {
  if (status === "accepted" || status === "done") return "done"
  if (status === "failed" || status === "cancelled") return "failed"
  if (["running", "submitted", "reviewing", "revision_requested", "revising"].includes(status)) return "running"
  return "queued"
}

export function visibleTaskRows<T extends TaskRow>(rows: readonly T[], limit = doneLimit, showAllDone = false): T[] {
  const active = rows
    .filter((row) => row.status !== "done")
    .map((row, index) => ({ row, index }))
    .sort((a, b) => taskStatusRank(a.row.status) - taskStatusRank(b.row.status) || a.index - b.index)
    .map((item) => item.row)
  const done = rows.filter((row) => row.status === "done")
  return [...active, ...(showAllDone ? done : done.slice(-limit))]
}

function hiddenDoneCount(rows: readonly TaskRow[], visible: readonly TaskRow[]) {
  return rows.filter((row) => row.status === "done").length - visible.filter((row) => row.status === "done").length
}

function taskRows(api: TuiPluginApi, sessionID: string): TaskRow[] {
  return api.state.session.agentCluster(sessionID).tasks.map((task) => ({
    id: task.id,
    status: clusterTaskStatus(task.status),
    title: task.title,
    role: task.role,
  }))
}

function View(props: { api: TuiPluginApi; session_id: string }) {
  const [showAllDone, setShowAllDone] = createSignal(false)
  const theme = () => props.api.theme.current
  const session = createMemo(() => props.api.state.session.get(props.session_id))
  const multiAgentEnabled = createMemo(
    () => (session()?.multiAgent ?? props.api.state.config.agent_cluster?.default_on) === true,
  )
  const rows = createMemo(() => taskRows(props.api, props.session_id))
  const visible = createMemo(() => visibleTaskRows(rows(), doneLimit, showAllDone()))
  const moreDone = createMemo(() => hiddenDoneCount(rows(), visible()))

  return (
    <Show when={rows().length > 0 && !multiAgentEnabled()}>
      <box>
        <text fg={theme().text}>
          <b>Tasks</b>
        </text>
        <For each={visible()}>
          {(row) => <TaskItem id={row.id} status={row.status} title={row.title} role={row.role} />}
        </For>
        <Show when={moreDone() > 0}>
          <box flexDirection="row" gap={0} onMouseDown={() => setShowAllDone(true)}>
            <text flexShrink={0} style={{ fg: theme().textMuted }}>
              [+]{" "}
            </text>
            <text flexGrow={1} style={{ fg: theme().textMuted }}>
              {moreDone()} more done
            </text>
          </box>
        </Show>
      </box>
    </Show>
  )
}

const tui: TuiPlugin = async (api) => {
  api.slots.register({
    order: 375,
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
