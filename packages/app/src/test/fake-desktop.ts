import { vi } from "vitest"
import type { DesktopBridge, LastLocation, RecentProject } from "../platform/types"
import { parseDesktopSettings, type DesktopSettings } from "../features/settings/settings-preferences"

export function createFakeDesktop(input?: {
  directory?: string
  lastLocation?: LastLocation
  recentProjects?: RecentProject[]
  settings?: DesktopSettings
}) {
  const directory = input?.directory ?? "C:\\work\\demo"
  let lastLocation = input?.lastLocation ?? {}
  let recentProjects = input?.recentProjects ?? []
  let settings = parseDesktopSettings(input?.settings)

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
    loadSettings: vi.fn(async () => ({ ...settings })),
    saveSettings: vi.fn(async (value) => {
      settings = parseDesktopSettings(value)
    }),
    revealConfigFile: vi.fn(async () => undefined),
  }

  return {
    bridge,
    directory,
    lastLocation: () => ({ ...lastLocation }),
    recentProjects: () => [...recentProjects],
    settings: () => ({ ...settings }),
  }
}
