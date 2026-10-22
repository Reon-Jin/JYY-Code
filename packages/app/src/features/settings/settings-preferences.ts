export type StartupPreference = "restore" | "home"
export type AppLocale = "zh-CN" | "en-US"
export type UpdatePolicy = "install" | "notify" | "off"

// ECB reference rates, 2026-10-21: EUR/CNY 7.4999 / EUR/USD 1.1234.
// https://www.ecb.europa.eu/stats/policy_and_exchange_rates/euro_reference_exchange_rates/html/index.eu.html
// This is a configurable estimate, never a live or settlement exchange rate.
export const DEFAULT_USD_TO_CNY = 6.6761

export function validUsdToCny(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 && value <= 100
}

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
  usdToCny: number
}

export const defaultDesktopSettings: DesktopSettings = {
  startup: "restore",
  locale: "zh-CN",
  notifications: { completion: true, permission: true, question: true },
  updatePolicy: "notify",
  soundEffects: true,
  usdToCny: DEFAULT_USD_TO_CNY,
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
    usdToCny: validUsdToCny(candidate.usdToCny) ? candidate.usdToCny : DEFAULT_USD_TO_CNY,
  }
}
