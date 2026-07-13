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
}

export interface DesktopBridge {
  bootstrap(): Promise<DesktopBootstrap>
  restartBackend(): Promise<void>
  chooseDirectory(): Promise<string | undefined>
  createProjectDirectory(parent: string, name: string): Promise<string>
  loadRecentProjects(): Promise<RecentProject[]>
  saveRecentProjects(projects: RecentProject[]): Promise<void>
  loadLastLocation(): Promise<LastLocation>
  saveLastLocation(value: LastLocation): Promise<void>
}

export function parseLastLocation(value: unknown): LastLocation {
  if (!value || typeof value !== "object") return {}

  const candidate = value as Record<string, unknown>
  return {
    ...(typeof candidate.project === "string" ? { project: candidate.project } : {}),
    ...(typeof candidate.sessionID === "string" ? { sessionID: candidate.sessionID } : {}),
  }
}
