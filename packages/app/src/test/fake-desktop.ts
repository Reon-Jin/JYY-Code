import { vi } from "vitest"
import type { DesktopBridge, LastLocation, MobileDevice, RecentProject } from "../platform/types"
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
  let mobileDevices: MobileDevice[] = []

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
    loadSettings: vi.fn(async () => parseDesktopSettings(settings)),
    saveSettings: vi.fn(async (value) => {
      settings = parseDesktopSettings(value)
    }),
    setWindowGlass: vi.fn(async () => ({ supported: true })),
    getNotificationPermission: vi.fn(async () => "granted" as const),
    requestNotificationPermission: vi.fn(async () => "granted" as const),
    sendNotification: vi.fn(async () => ({ supported: true })),
    checkForUpdate: vi.fn(async () => ({ supported: true, available: false })),
    installAvailableUpdate: vi.fn(async () => ({ supported: true })),
    saveTextFile: vi.fn(async () => ({ supported: true, saved: true })),
    revealConfigFile: vi.fn(async () => undefined),
    mobileListDevices: vi.fn(async () => [...mobileDevices]),
    mobileStartPairing: vi.fn(async () => ({
      routeId: "desktop_test",
      relayUrl: "wss://relay.test/connect",
      temporaryPublicKey: "public-key",
      expiresAt: Date.now() + 5 * 60_000,
      qrPayload: "{\"routeId\":\"desktop_test\"}",
    })),
    mobilePairingStatus: vi.fn(async () => ({ routeId: "desktop_test", relayUrl: "wss://relay.test/connect", tunnelReady: true, pairedDevices: mobileDevices.length })),
    mobileRevokeDevice: vi.fn(async (deviceID) => {
      mobileDevices = mobileDevices.filter((device) => device.id !== deviceID)
    }),
  }

  return {
    bridge,
    directory,
    lastLocation: () => ({ ...lastLocation }),
    recentProjects: () => [...recentProjects],
    settings: () => parseDesktopSettings(settings),
    mobileDevices: () => [...mobileDevices],
  }
}
