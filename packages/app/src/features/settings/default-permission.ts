import { tr } from "../../i18n/i18n-context"

export type DefaultPermissionMode = "auto" | "request" | "full" | "custom"

const labelKeys = {
  auto: "settings.permission-mode-auto",
  request: "settings.permission-mode-request",
  full: "settings.permission-mode-full",
  custom: "settings.permission-mode-custom",
} as const satisfies Record<DefaultPermissionMode, Parameters<typeof tr>[0]>

export function displayDefaultPermission(input: { mode: DefaultPermissionMode }) {
  return { label: tr(labelKeys[input.mode]), editable: input.mode !== "custom" }
}
