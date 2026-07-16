import { beforeEach, describe, expect, it, vi } from "vitest"

const state = vi.hoisted(() => ({
  values: new Map<string, unknown>(),
  save: vi.fn(async () => undefined),
  invoke: vi.fn(async () => undefined),
  isPermissionGranted: vi.fn(async () => true),
  requestPermission: vi.fn(async () => "granted" as const),
  sendNotification: vi.fn(),
  checkUpdate: vi.fn(),
  downloadAndInstall: vi.fn(async () => undefined),
  closeUpdate: vi.fn(async () => undefined),
  relaunch: vi.fn(async () => undefined),
}))

vi.mock("@tauri-apps/api/core", () => ({ invoke: state.invoke }))
vi.mock("@tauri-apps/plugin-dialog", () => ({ open: vi.fn() }))
vi.mock("@tauri-apps/plugin-notification", () => ({
  isPermissionGranted: state.isPermissionGranted,
  requestPermission: state.requestPermission,
  sendNotification: state.sendNotification,
}))
vi.mock("@tauri-apps/plugin-store", () => ({
  Store: {
    load: vi.fn(async () => ({
      get: async (key: string) => state.values.get(key),
      set: async (key: string, value: unknown) => state.values.set(key, structuredClone(value)),
      save: state.save,
    })),
  },
}))
vi.mock("@tauri-apps/plugin-updater", () => ({ check: state.checkUpdate }))
vi.mock("@tauri-apps/plugin-process", () => ({ relaunch: state.relaunch }))

import { tauriBridge } from "./tauri"
import { defaultDesktopSettings } from "../features/settings/settings-preferences"

describe("Tauri desktop settings persistence", () => {
  beforeEach(() => {
    state.values.clear()
    state.save.mockClear()
    state.invoke.mockClear()
    state.sendNotification.mockClear()
    state.checkUpdate.mockReset()
    state.downloadAndInstall.mockClear()
    state.closeUpdate.mockClear()
    state.relaunch.mockClear()
  })

  it("round-trips settings through desktop.json", async () => {
    await tauriBridge.saveSettings({ ...defaultDesktopSettings, startup: "home", theme: "light" })

    expect(state.values.get("settings")).toEqual({ ...defaultDesktopSettings, startup: "home", theme: "light" })
    expect(state.save).toHaveBeenCalledOnce()
    expect(await tauriBridge.loadSettings()).toEqual({ ...defaultDesktopSettings, startup: "home", theme: "light" })
  })

  it("uses serializable command payloads for native capabilities", async () => {
    await tauriBridge.setWindowGlass(true, "dark")
    await tauriBridge.getNotificationPermission?.()
    await tauriBridge.requestNotificationPermission()
    await tauriBridge.sendNotification({ title: "JYYCode", body: "Ready" })
    await tauriBridge.saveTextFile("memory.json", "{}")

    expect(state.invoke.mock.calls).toEqual([
      ["set_window_glass", { enabled: true, theme: "dark" }],
      ["save_text_file", { suggestedName: "memory.json", contents: "{}" }],
    ])
    expect(state.requestPermission).toHaveBeenCalledOnce()
    expect(state.sendNotification).toHaveBeenCalledWith({ title: "JYYCode", body: "Ready" })
  })

  it("checks, installs, closes, and relaunches a signed update", async () => {
    state.checkUpdate.mockResolvedValueOnce({
      currentVersion: "1.0.0",
      version: "1.1.0",
      body: "New release",
      downloadAndInstall: state.downloadAndInstall,
      close: state.closeUpdate,
    })

    await expect(tauriBridge.checkForUpdate()).resolves.toEqual({
      supported: true,
      available: true,
      currentVersion: "1.0.0",
      version: "1.1.0",
      notes: "New release",
    })
    await expect(tauriBridge.installAvailableUpdate()).resolves.toEqual({ supported: true })

    expect(state.downloadAndInstall).toHaveBeenCalledOnce()
    expect(state.closeUpdate).toHaveBeenCalledOnce()
    expect(state.relaunch).toHaveBeenCalledOnce()
  })

  it("reports when no update is available", async () => {
    state.checkUpdate.mockResolvedValueOnce(null)

    await expect(tauriBridge.checkForUpdate()).resolves.toEqual({ supported: true, available: false })
    await expect(tauriBridge.installAvailableUpdate()).resolves.toEqual({
      supported: false,
      reason: "No update is available",
    })
  })

  it("passes config reveal as a command argument", async () => {
    await tauriBridge.revealConfigFile("C:\\Users\\dev\\.config\\jyycode\\jyycode.jsonc")

    expect(state.invoke).toHaveBeenCalledWith("reveal_config_file", {
      path: "C:\\Users\\dev\\.config\\jyycode\\jyycode.jsonc",
    })
  })
})
