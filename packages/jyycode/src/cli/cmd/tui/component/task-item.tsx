import { useTheme } from "../context/theme"
import type { AgentClusterTaskStatus } from "../routes/session/agent-cluster-state"

export function taskStatusRank(status: AgentClusterTaskStatus) {
  if (status === "running") return 0
  if (status === "queued") return 1
  if (status === "failed") return 2
  return 3
}

export function TaskItem(props: {
  id: string
  status: AgentClusterTaskStatus
  title: string
  role?: string
  depth?: number
}) {
  const { theme } = useTheme()
  const running = () => props.status === "running"
  const marker = () => {
    if (props.status === "done") return "[x]"
    if (props.status === "failed") return "[!]"
    if (running()) return "[>]"
    return "[ ]"
  }

  return (
    <box flexDirection="row" gap={0} paddingLeft={props.depth ?? 0}>
      <text
        flexShrink={0}
        style={{
          fg: running() ? theme.warning : theme.textMuted,
        }}
      >
        {marker()}{" "}
      </text>
      <text
        flexGrow={1}
        wrapMode="word"
        style={{
          fg: running() ? theme.warning : theme.textMuted,
        }}
      >
        <span style={{ fg: theme.textMuted }}>{props.id}</span> {props.title}
      </text>
    </box>
  )
}
