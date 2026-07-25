import { useTheme } from "../context/theme"
import { StatusIcon } from "./status-icon"

export type WorkspaceStatus = "connected" | "connecting" | "disconnected" | "error"

export function WorkspaceLabel(props: { type: string; name: string; status?: WorkspaceStatus; icon?: boolean }) {
  const { theme } = useTheme()

  const iconStatus = () => {
    if (props.status === "connected") return "success" as const
    if (props.status === "error") return "error" as const
    return "pending" as const
  }

  return (
    <>
      {props.icon ? <StatusIcon status={iconStatus()} /> : undefined}
      {props.icon ? " " : undefined}
      <span style={{ fg: theme.text }}>{props.name}</span> <span style={{ fg: theme.textMuted }}>({props.type})</span>
    </>
  )
}
