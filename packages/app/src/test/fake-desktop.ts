import { vi } from "vitest"
import type { DesktopBridge, LastLocation, RecentProject } from "../platform/types"

export function createFakeDesktop(input?: {
  directory?: string
  lastLocation?: LastLocation
  recentProjects?: RecentProject[]
}) {
  const directory = input?.directory ?? "C:\\work\\demo"
  let lastLocation = input?.lastLocation ?? {}
  let recentProjects = input?.recentProjects ?? []

  const bridge: DesktopBridge = {
    bootstrap: vi.fn(async () => ({
      baseUrl: "http://desktop.test",
      username: "jyycode",
      password: "desktop-secret",
      logPath: "C:\\logs\\jyycode.log",
    })),
    restartBackend: vi.fn(async () => undefined),
    chooseDirectory: vi.fn(async () => directory),
    createProjectDirectory: vi.fn(async () => directory),
    loadRecentProjects: vi.fn(async () => [...recentProjects]),
    saveRecentProjects: vi.fn(async (value) => {
      recentProjects = [...value]
    }),
    loadLastLocation: vi.fn(async () => ({ ...lastLocation })),
    saveLastLocation: vi.fn(async (value) => {
      lastLocation = { ...value }
    }),
  }

  return {
    bridge,
    directory,
    lastLocation: () => ({ ...lastLocation }),
    recentProjects: () => [...recentProjects],
  }
}
