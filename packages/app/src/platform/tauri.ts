import { invoke } from "@tauri-apps/api/core"
import { open } from "@tauri-apps/plugin-dialog"
import { Store } from "@tauri-apps/plugin-store"
import { normalizeRecentProjects } from "./recent-projects"
import { parseDesktopSettings, type DesktopSettings } from "../features/settings/settings-preferences"
import {
  parseLastLocation,
  type DesktopBootstrap,
  type DesktopBridge,
  type DesktopCapabilityResult,
  type LastLocation,
  type DesktopNotification,
  type DesktopNotificationPermission,
  type RecentProject,
  type DesktopSaveResult,
  type DesktopUpdateCheck,
} from "./types"

const STORE_PATH = "desktop.json"
const RECENT_PROJECTS_KEY = "recentProjects"
const LAST_LOCATION_KEY = "lastLocation"
const SETTINGS_KEY = "settings"

let storePromise: Promise<Store> | undefined

function desktopStore() {
  storePromise ??= Store.load(STORE_PATH)
  return storePromise
}

export const tauriBridge: DesktopBridge = {
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
  setWindowGlass(enabled, theme) {
    return invoke<DesktopCapabilityResult>("set_window_glass", { enabled, theme })
  },
  requestNotificationPermission() {
    return invoke<DesktopNotificationPermission>("request_notification_permission")
  },
  sendNotification(notification: DesktopNotification) {
    return invoke<DesktopCapabilityResult>("send_notification", { notification })
  },
  checkForUpdate() {
    return invoke<DesktopUpdateCheck>("check_for_update")
  },
  installAvailableUpdate() {
    return invoke<DesktopCapabilityResult>("install_available_update")
  },
  saveTextFile(suggestedName, contents) {
    return invoke<DesktopSaveResult>("save_text_file", { suggestedName, contents })
  },
  revealConfigFile(path: string) {
    return invoke("reveal_config_file", { path })
  },
}
