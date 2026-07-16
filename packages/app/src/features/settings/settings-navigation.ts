export type SettingsSection = "general" | "security" | "advanced"

export function sanitizeSettingsReturnTo(value: string | undefined | null) {
  if (value === "/" || value === "/workspace") return value
  if (value && /^\/session\/[^/?#]+$/.test(value)) return value
  return "/"
}

export function settingsHref(section: SettingsSection, returnTo: string | undefined | null) {
  return `/settings/${section}?returnTo=${encodeURIComponent(sanitizeSettingsReturnTo(returnTo))}`
}
