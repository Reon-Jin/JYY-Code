import { invoke } from "@tauri-apps/api/core"
import { open } from "@tauri-apps/plugin-dialog"
import { isPermissionGranted, requestPermission } from "@tauri-apps/plugin-notification"
import { Store } from "@tauri-apps/plugin-store"
import { check, type Update } from "@tauri-apps/plugin-updater"
import { normalizeRecentProjects } from "./recent-projects"
import { parseDesktopSettings, type DesktopSettings } from "../features/settings/settings-preferences"
import {
  parseLastLocation,
  type DesktopBootstrap,
  type DesktopBridge,
  type DesktopCapabilityResult,
  type LastLocation,
  type DesktopNotification,
  type RecentProject,
  type DesktopSaveResult,
  type DesktopUpdateCheck,
} from "./types"

const STORE_PATH = "desktop.json"
const RECENT_PROJECTS_KEY = "recentProjects"
const LAST_LOCATION_KEY = "lastLocation"
const SETTINGS_KEY = "settings"

let storePromise: Promise<Store> | undefined
let pendingUpdate: Update | undefined

export function automaticUpdatesSupported(_userAgent: string) {
  return true
}

function desktopStore() {
  storePromise ??= Store.load(STORE_PATH)
  return storePromise
}

export const tauriBridge: DesktopBridge = {
  supportsAutomaticUpdates: true,
  bootstrap() {
    return invoke<DesktopBootstrap>("desktop_bootstrap")
  },
  restartBackend() {
    return invoke("restart_backend")
  },
  async chooseDirectory() {
    const selected = await open({ directory: true, multiple: false })
    return selected ?? undefined
  },
  createProjectDirectory(parent: string, name: string) {
    return invoke("create_project_directory", { parent, name })
  },
  async loadRecentProjects() {
    const store = await desktopStore()
    return normalizeRecentProjects(await store.get(RECENT_PROJECTS_KEY))
  },
  async saveRecentProjects(projects: RecentProject[]) {
    const store = await desktopStore()
    await store.set(RECENT_PROJECTS_KEY, normalizeRecentProjects(projects))
    await store.save()
  },
  async loadLastLocation() {
    const store = await desktopStore()
    return parseLastLocation(await store.get(LAST_LOCATION_KEY))
  },
  async saveLastLocation(value: LastLocation) {
    const store = await desktopStore()
    await store.set(LAST_LOCATION_KEY, parseLastLocation(value))
    await store.save()
  },
  async loadSettings() {
    const store = await desktopStore()
    return parseDesktopSettings(await store.get(SETTINGS_KEY))
  },
  async saveSettings(value: DesktopSettings) {
    const store = await desktopStore()
    await store.set(SETTINGS_KEY, parseDesktopSettings(value))
    await store.save()
  },
  async getNotificationPermission() {
    return (await isPermissionGranted()) ? "granted" : "default"
  },
  requestNotificationPermission() {
    return requestPermission()
  },
  async sendNotification(notification: DesktopNotification) {
    if (!(await isPermissionGranted())) return { supported: false, reason: "Notification permission is not granted" }
    return invoke<DesktopCapabilityResult>("send_desktop_notification", { notification })
  },
  async checkForUpdate() {
    if (pendingUpdate) {
      await pendingUpdate.close().catch(() => undefined)
      pendingUpdate = undefined
    }
    const update = await check({ timeout: 30_000 })
    if (!update) return { supported: true, available: false }
    pendingUpdate = update
    return {
      supported: true,
      available: true,
      currentVersion: update.currentVersion,
      version: update.version,
      ...(update.body ? { notes: update.body } : {}),
    }
  },
  async installAvailableUpdate() {
    if (!pendingUpdate) return { supported: false, reason: "No update is available" }
    const update = pendingUpdate
    await update.download()
    await invoke("stop_backend_for_update")
    try {
      await update.install()
    } catch (cause) {
      await invoke("restart_backend").catch(() => undefined)
      throw cause
    }
    pendingUpdate = undefined
    await update.close().catch(() => undefined)
    return { supported: true }
  },
  saveTextFile(suggestedName, contents) {
    return invoke<DesktopSaveResult>("save_text_file", { suggestedName, contents })
  },
  revealConfigFile(path: string) {
    return invoke("reveal_config_file", { path })
  },
}
