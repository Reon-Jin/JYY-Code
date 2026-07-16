export type StartupPreference = "restore" | "home"
export type ColorTheme = "dark" | "light"
export type AppLocale = "zh-CN" | "en-US"
export type GlassPreference = "off" | "on"
export type UpdatePolicy = "install" | "notify" | "off"

export type NotificationPreferences = {
  completion: boolean
  permission: boolean
  question: boolean
}

export type DesktopSettings = {
  startup: StartupPreference
  theme: ColorTheme
  locale: AppLocale
  glass: GlassPreference
  notifications: NotificationPreferences
  updatePolicy: UpdatePolicy
}

export const defaultDesktopSettings: DesktopSettings = {
  startup: "restore",
  theme: "dark",
  locale: "zh-CN",
  glass: "off",
  notifications: { completion: true, permission: true, question: true },
  updatePolicy: "notify",
}

export function parseDesktopSettings(value: unknown): DesktopSettings {
  const candidate = value && typeof value === "object" ? (value as Record<string, unknown>) : {}
  const notifications =
    candidate.notifications && typeof candidate.notifications === "object"
      ? (candidate.notifications as Record<string, unknown>)
      : {}
  return {
    startup: candidate.startup === "home" || candidate.startup === "restore" ? candidate.startup : "restore",
    theme: candidate.theme === "light" || candidate.theme === "dark" ? candidate.theme : "dark",
    locale: candidate.locale === "en-US" || candidate.locale === "zh-CN" ? candidate.locale : "zh-CN",
    glass: candidate.glass === "on" || candidate.glass === "off" ? candidate.glass : "off",
    notifications: {
      completion: typeof notifications.completion === "boolean" ? notifications.completion : true,
      permission: typeof notifications.permission === "boolean" ? notifications.permission : true,
      question: typeof notifications.question === "boolean" ? notifications.question : true,
    },
    updatePolicy:
      candidate.updatePolicy === "install" || candidate.updatePolicy === "notify" || candidate.updatePolicy === "off"
        ? candidate.updatePolicy
        : "notify",
  }
}
