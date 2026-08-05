export type StartupPreference = "restore" | "home"
export type AppLocale = "zh-CN" | "en-US"
export type UpdatePolicy = "install" | "notify" | "off"

export type NotificationPreferences = {
  completion: boolean
  permission: boolean
  question: boolean
}

export type DesktopSettings = {
  startup: StartupPreference
  locale: AppLocale
  notifications: NotificationPreferences
  updatePolicy: UpdatePolicy
  soundEffects: boolean
}

export const defaultDesktopSettings: DesktopSettings = {
  startup: "restore",
  locale: "zh-CN",
  notifications: { completion: true, permission: true, question: true },
  updatePolicy: "notify",
  soundEffects: true,
}

export function parseDesktopSettings(value: unknown): DesktopSettings {
  const candidate = value && typeof value === "object" ? (value as Record<string, unknown>) : {}
  const notifications =
    candidate.notifications && typeof candidate.notifications === "object"
      ? (candidate.notifications as Record<string, unknown>)
      : {}
  return {
    startup: candidate.startup === "home" || candidate.startup === "restore" ? candidate.startup : "restore",
    locale: candidate.locale === "en-US" || candidate.locale === "zh-CN" ? candidate.locale : "zh-CN",
    notifications: {
      completion: typeof notifications.completion === "boolean" ? notifications.completion : true,
      permission: typeof notifications.permission === "boolean" ? notifications.permission : true,
      question: typeof notifications.question === "boolean" ? notifications.question : true,
    },
    updatePolicy:
      candidate.updatePolicy === "install" || candidate.updatePolicy === "notify" || candidate.updatePolicy === "off"
        ? candidate.updatePolicy
        : "notify",
    soundEffects: typeof candidate.soundEffects === "boolean" ? candidate.soundEffects : true,
  }
}
