export type DesktopBootstrap = {
  baseUrl: string
  username: string
  password: string
  logPath?: string
}

export type RecentProject = {
  path: string
  usedAt: number
}

export type LastLocation = {
  project?: string
  sessionID?: string
  openProjects?: Array<{
    path: string
    sessionID?: string
  }>
}

export type DesktopCapabilityResult = {
  supported: boolean
  reason?: string
}

export type DesktopNotificationPermission = "granted" | "denied" | "default" | "unsupported"

export type DesktopNotification = {
  title: string
  body: string
}

export type DesktopUpdateCheck = DesktopCapabilityResult & {
  available: boolean
  currentVersion?: string
  version?: string
  notes?: string
}

export type DesktopSaveResult = DesktopCapabilityResult & {
  saved: boolean
}

export interface DesktopBridge {
  supportsAutomaticUpdates?: boolean
  bootstrap(): Promise<DesktopBootstrap>
  restartBackend(): Promise<void>
  chooseDirectory(): Promise<string | undefined>
  createProjectDirectory(parent: string, name: string): Promise<string>
  loadRecentProjects(): Promise<RecentProject[]>
  saveRecentProjects(projects: RecentProject[]): Promise<void>
  loadLastLocation(): Promise<LastLocation>
  saveLastLocation(value: LastLocation): Promise<void>
  loadSettings(): Promise<DesktopSettings>
  saveSettings(value: DesktopSettings): Promise<void>
  setWindowGlass(enabled: boolean, theme: "dark" | "light"): Promise<DesktopCapabilityResult>
  getNotificationPermission?(): Promise<DesktopNotificationPermission>
  requestNotificationPermission(): Promise<DesktopNotificationPermission>
  sendNotification(notification: DesktopNotification): Promise<DesktopCapabilityResult>
  checkForUpdate(): Promise<DesktopUpdateCheck>
  installAvailableUpdate(): Promise<DesktopCapabilityResult>
  saveTextFile(suggestedName: string, contents: string): Promise<DesktopSaveResult>
  revealConfigFile(path: string): Promise<void>
}

export function parseLastLocation(value: unknown): LastLocation {
  if (!value || typeof value !== "object") return {}

  const candidate = value as Record<string, unknown>
  const openProjects = Array.isArray(candidate.openProjects)
    ? candidate.openProjects.flatMap((value) => {
        if (!value || typeof value !== "object") return []
        const project = value as Record<string, unknown>
        if (typeof project.path !== "string" || !project.path.trim()) return []
        return [
          { path: project.path, ...(typeof project.sessionID === "string" ? { sessionID: project.sessionID } : {}) },
        ]
      })
    : []
  return {
    ...(typeof candidate.project === "string" ? { project: candidate.project } : {}),
    ...(typeof candidate.sessionID === "string" ? { sessionID: candidate.sessionID } : {}),
    ...(openProjects.length ? { openProjects } : {}),
  }
}
import type { DesktopSettings } from "../features/settings/settings-preferences"
