export type StartupPreference = "restore" | "home"
export type ColorTheme = "dark" | "light"

export type DesktopSettings = {
  startup: StartupPreference
  theme: ColorTheme
}

export const defaultDesktopSettings: DesktopSettings = { startup: "restore", theme: "dark" }

export function parseDesktopSettings(value: unknown): DesktopSettings {
  const candidate = value && typeof value === "object" ? (value as Record<string, unknown>) : {}
  return {
    startup: candidate.startup === "home" || candidate.startup === "restore" ? candidate.startup : "restore",
    theme: candidate.theme === "light" || candidate.theme === "dark" ? candidate.theme : "dark",
  }
}
