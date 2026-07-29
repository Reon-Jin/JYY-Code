import type { AppLocale } from "../features/settings/settings-preferences"

export type MessageValues = Record<string, string | number>

export function formatMessage(template: string | undefined, values: MessageValues = {}) {
  if (typeof template !== "string") return ""
  return template.replace(/\{([A-Za-z][A-Za-z0-9_]*)\}/g, (placeholder, name: string) => {
    const value = values[name]
    return value === undefined ? placeholder : String(value)
  })
}

export function formatDateTime(locale: AppLocale, value: Date | number) {
  return new Intl.DateTimeFormat(locale, { dateStyle: "medium", timeStyle: "short" }).format(value)
}

export function formatRelativeTime(locale: AppLocale, value: number, unit: Intl.RelativeTimeFormatUnit) {
  return new Intl.RelativeTimeFormat(locale, { numeric: "auto" }).format(value, unit)
}
