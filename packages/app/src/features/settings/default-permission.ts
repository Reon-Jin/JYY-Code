export type DefaultPermissionMode = "auto" | "request" | "full" | "custom"

const labels: Record<DefaultPermissionMode, string> = {
  auto: "自动",
  request: "每次询问",
  full: "完全访问",
  custom: "自定义配置",
}

export function displayDefaultPermission(input: { mode: DefaultPermissionMode }) {
  return { label: labels[input.mode], editable: input.mode !== "custom" }
}
