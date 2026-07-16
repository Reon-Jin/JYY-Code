import { normalizeRecentProjects } from "./recent-projects"
import { parseDesktopSettings, type DesktopSettings } from "../features/settings/settings-preferences"
import { parseLastLocation, type DesktopBridge, type LastLocation, type RecentProject } from "./types"

const RECENT_PROJECTS_KEY = "jyycode.desktop.recent-projects"
const LAST_LOCATION_KEY = "jyycode.desktop.last-location"
const SETTINGS_KEY = "jyycode.desktop.settings"

function unsupported(operation: string): never {
  throw new Error(`${operation} is only available in the JYYCode desktop application`)
}

function unsupportedResult(operation: string) {
  return { supported: false, reason: `${operation} is only available in the JYYCode desktop application` } as const
}

function readStorage(storage: Storage, key: string): unknown {
  const value = storage.getItem(key)
  if (value === null) return undefined
  try {
    return JSON.parse(value)
  } catch {
    return undefined
  }
}

export function createBrowserBridge(storage: Storage = window.localStorage): DesktopBridge {
  return {
    async bootstrap() {
      return unsupported("Backend startup")
    },
    async restartBackend() {
      unsupported("Backend restart")
    },
    async chooseDirectory() {
      return unsupported("Directory selection")
    },
    async createProjectDirectory() {
      return unsupported("Project directory creation")
    },
    async loadRecentProjects() {
      return normalizeRecentProjects(readStorage(storage, RECENT_PROJECTS_KEY))
    },
    async saveRecentProjects(projects: RecentProject[]) {
      storage.setItem(RECENT_PROJECTS_KEY, JSON.stringify(normalizeRecentProjects(projects)))
    },
    async loadLastLocation() {
      return parseLastLocation(readStorage(storage, LAST_LOCATION_KEY))
    },
    async saveLastLocation(value: LastLocation) {
      storage.setItem(LAST_LOCATION_KEY, JSON.stringify(parseLastLocation(value)))
    },
    async loadSettings() {
      return parseDesktopSettings(readStorage(storage, SETTINGS_KEY))
    },
    async saveSettings(value: DesktopSettings) {
      storage.setItem(SETTINGS_KEY, JSON.stringify(parseDesktopSettings(value)))
    },
    async setWindowGlass() {
      return unsupportedResult("Window glass")
    },
    async requestNotificationPermission() {
      return "unsupported"
    },
    async sendNotification() {
      return unsupportedResult("System notifications")
    },
    async checkForUpdate() {
      return { ...unsupportedResult("Automatic updates"), available: false }
    },
    async installAvailableUpdate() {
      return unsupportedResult("Automatic updates")
    },
    async saveTextFile(suggestedName, contents) {
      const blob = new Blob([contents], { type: "text/plain;charset=utf-8" })
      const url = URL.createObjectURL(blob)
      const anchor = document.createElement("a")
      anchor.href = url
      anchor.download = suggestedName
      anchor.click()
      URL.revokeObjectURL(url)
      return { supported: true, saved: true }
    },
    async revealConfigFile() {
      unsupported("Config file reveal")
    },
  }
}
