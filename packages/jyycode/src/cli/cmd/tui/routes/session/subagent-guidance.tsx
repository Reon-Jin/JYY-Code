import { createMemo, Show } from "solid-js"
import { useRouteData } from "@tui/context/route"
import { useSync } from "@tui/context/sync"
import { useTheme } from "@tui/context/theme"
import { useTerminalDimensions } from "@opentui/solid"

export function SubagentGuidance() {
  const route = useRouteData("session")
  const sync = useSync()
  const { theme } = useTheme()

  const session = createMemo(() => sync.session.get(route.sessionID))

  const isChildSession = createMemo(() => {
    const s = session()
    if (!s) return false
    return !!s.parentID
  })

  // Check cluster task binding
  const clusterTask = createMemo(() => {
    const s = session()
    if (!s?.parentID) return undefined
    const cluster = sync.data.agent_cluster[s.parentID]
    if (!cluster) return undefined
    const task = cluster.tasks.find((t) => t.child_session_id === route.sessionID)
    if (!task) return undefined
    return {
      planTaskID: task.plan_task_id ?? task.id,
      status: task.status,
    }
  })

  const isTerminal = createMemo(() => {
    const task = clusterTask()
    if (!task) return true
    return ["accepted", "failed", "cancelled"].includes(task.status)
  })

  useTerminalDimensions()

  return (
    <Show when={isChildSession()}>
      <box flexShrink={0} paddingLeft={2} paddingRight={1} backgroundColor={theme.backgroundPanel}>
        <box flexDirection="row" gap={1}>
          <text fg={theme.textMuted}>
            <b>Guide subagent:</b>
          </text>
          <Show when={!isTerminal()} fallback={<text fg={theme.textMuted}>task finished</text>}>
            <text fg={theme.textMuted}>
              Use the HTTP API to send guidance. The subagent will receive it at the next checkpoint.
            </text>
          </Show>
        </box>
      </box>
    </Show>
  )
}
