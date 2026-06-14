import { createMemo, createSignal, For, Show } from "solid-js"
import { useRoute } from "../../context/route"
import { useSync } from "../../context/sync"
import { useTheme } from "../../context/theme"
import { useTuiConfig } from "../../context/tui-config"
import { getScrollAcceleration } from "../../util/scroll"
import { Locale } from "@/util/locale"
import { agentClusterSnapshot, type AgentClusterTaskStatus } from "./agent-cluster-state"

function statusColor(status: AgentClusterTaskStatus, theme: ReturnType<typeof useTheme>["theme"]) {
  if (status === "failed") return theme.error
  if (status === "running") return theme.warning
  if (status === "done") return theme.success
  return theme.text
}

export function MultiAgentPanel(props: { sessionID: string; enabled: boolean; disabled: boolean }) {
  const route = useRoute()
  const sync = useSync()
  const { theme } = useTheme()
  const tuiConfig = useTuiConfig()
  const [hoveredSessionID, setHoveredSessionID] = createSignal<string>()
  const scrollAcceleration = createMemo(() => getScrollAcceleration(tuiConfig))
  const snapshot = createMemo(() =>
    agentClusterSnapshot({
      sessionID: props.sessionID,
      enabled: props.enabled,
      disabled: props.disabled,
      cluster: sync.data.agent_cluster[props.sessionID],
      messages: (sessionID) => sync.data.message[sessionID] ?? [],
      parts: (messageID) => sync.data.part[messageID] ?? [],
      sessionStatus: (sessionID) => sync.data.session_status[sessionID],
    }),
  )
  const rows = createMemo(() => snapshot().rows)
  const visibleRows = createMemo(() => Math.min(rows().length, 12))

  return (
    <Show when={snapshot().visible}>
      <box flexDirection="column" gap={0} paddingLeft={1} paddingRight={1} paddingBottom={1}>
        <text fg={props.disabled ? theme.textMuted : props.enabled ? theme.success : theme.textMuted}>
          Multi-Agent {props.disabled ? "disabled" : props.enabled ? "*" : "o"}{" "}
          <span style={{ fg: theme.textMuted }}>
            main: {snapshot().status} steps: {snapshot().currentStep ?? "-"}/{snapshot().totalSteps || "-"} done:{" "}
            {snapshot().completedSteps}/{snapshot().totalSteps || 0} agents: {snapshot().totalAgents} running:{" "}
            {snapshot().runningAgents} done: {snapshot().doneAgents} failed: {snapshot().failedAgents}
          </span>
        </text>
        <Show when={rows().length > 0}>
          <scrollbox
            height={visibleRows()}
            paddingLeft={1}
            scrollbarOptions={{ visible: false }}
            scrollAcceleration={scrollAcceleration()}
          >
            <For each={rows()}>
              {(row) => {
                const clickable = createMemo(() => !!row.sessionID)
                const hovered = createMemo(() => !!row.sessionID && hoveredSessionID() === row.sessionID)

                return (
                  <text
                    fg={hovered() ? theme.text : statusColor(row.status, theme)}
                    bg={hovered() ? theme.backgroundPanel : undefined}
                    onMouseOver={() => {
                      if (row.sessionID) setHoveredSessionID(row.sessionID)
                    }}
                    onMouseOut={() => {
                      if (row.sessionID) setHoveredSessionID(undefined)
                    }}
                    onMouseUp={() => {
                      if (!clickable() || !row.sessionID) return
                      route.navigate({ type: "session", sessionID: row.sessionID })
                    }}
                  >
                    <span style={{ fg: theme.textMuted }}>{String(row.index).padStart(2, " ")} </span>
                    {Locale.titlecase(row.role).padEnd(10, " ").slice(0, 10)} {row.model.padEnd(24, " ").slice(0, 24)}{" "}
                    {row.status.padEnd(10, " ").slice(0, 10)} {Locale.truncate(row.task, 48)}
                  </text>
                )
              }}
            </For>
          </scrollbox>
        </Show>
      </box>
    </Show>
  )
}
