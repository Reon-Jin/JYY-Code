import { useTheme } from "../context/theme"
import type { RGBA } from "@opentui/core"

type StatusIconProps = {
  status: "success" | "error" | "warning" | "info" | "pending" | "loading"
}

const ICONS: Record<StatusIconProps["status"], string> = {
  success: "✓",
  error: "✗",
  warning: "⚠",
  info: "ℹ",
  pending: "○",
  loading: "…",
}

export function StatusIcon(props: StatusIconProps) {
  const { theme } = useTheme()
  const colorMap: Record<StatusIconProps["status"], () => RGBA> = {
    success: () => theme.success,
    error: () => theme.error,
    warning: () => theme.warning,
    info: () => theme.secondary,
    pending: () => theme.textMuted,
    loading: () => theme.textMuted,
  }
  const color = () => colorMap[props.status]()

  return <span style={{ fg: color() }}>{ICONS[props.status]}</span>
}
