import { beforeEach, describe, expect, it, vi } from "vitest"

const state = vi.hoisted(() => ({
  values: new Map<string, unknown>(),
  save: vi.fn(async () => undefined),
  invoke: vi.fn(async (..._args: unknown[]): Promise<unknown> => undefined),
  isPermissionGranted: vi.fn(async () => true),
  requestPermission: vi.fn(async () => "granted" as const),
  sendNotification: vi.fn(),
  checkUpdate: vi.fn(),
  downloadUpdate: vi.fn(async () => undefined),
  installUpdate: vi.fn(async () => undefined),
  closeUpdate: vi.fn(async () => undefined),
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

import { automaticUpdatesSupported, tauriBridge } from "./tauri"
import { defaultDesktopSettings } from "../features/settings/settings-preferences"

describe("Tauri desktop settings persistence", () => {
  beforeEach(() => {
    state.values.clear()
    state.save.mockClear()
    state.invoke.mockReset()
    state.sendNotification.mockClear()
    state.checkUpdate.mockReset()
    state.downloadUpdate.mockReset()
    state.installUpdate.mockReset()
    state.closeUpdate.mockClear()
  })

  it("round-trips settings through desktop.json", async () => {
    await tauriBridge.saveSettings({ ...defaultDesktopSettings, startup: "home", theme: "light" })

    expect(state.values.get("settings")).toEqual({ ...defaultDesktopSettings, startup: "home", theme: "light" })
    expect(state.save).toHaveBeenCalledOnce()
    expect(await tauriBridge.loadSettings()).toEqual({ ...defaultDesktopSettings, startup: "home", theme: "light" })
  })

  it("supports automatic updates on macOS and Windows WebViews", () => {
    expect(automaticUpdatesSupported("Mozilla/5.0 (Macintosh; Intel Mac OS X 13_0)")).toBe(true)
    expect(automaticUpdatesSupported("Mozilla/5.0 (Windows NT 10.0; Win64; x64)")).toBe(true)
  })

  it("uses serializable command payloads for native capabilities", async () => {
    state.invoke.mockImplementation(async (...args: unknown[]) =>
      args[0] === "send_desktop_notification" ? { supported: true } : undefined,
    )
    await tauriBridge.setWindowGlass(true, "dark")
    await tauriBridge.getNotificationPermission?.()
    await tauriBridge.requestNotificationPermission()
    await expect(tauriBridge.sendNotification({ title: "JYYCode", body: "Ready" })).resolves.toEqual({
      supported: true,
    })
    await tauriBridge.saveTextFile("memory.json", "{}")

    expect(state.invoke.mock.calls).toEqual([
      ["set_window_glass", { enabled: true, theme: "dark" }],
      ["send_desktop_notification", { notification: { title: "JYYCode", body: "Ready" } }],
      ["save_text_file", { suggestedName: "memory.json", contents: "{}" }],
    ])
    expect(state.requestPermission).toHaveBeenCalledOnce()
    expect(state.sendNotification).not.toHaveBeenCalled()
  })

  it("downloads, stops the sidecar, and only then starts the signed installer", async () => {
    const order: string[] = []
    state.downloadUpdate.mockImplementation(async () => void order.push("download"))
    state.invoke.mockImplementation(async (...args: unknown[]) => {
      if (args[0] === "stop_backend_for_update") order.push("stop")
      return undefined
    })
    state.installUpdate.mockImplementation(async () => void order.push("install"))
    state.checkUpdate.mockResolvedValueOnce({
      currentVersion: "1.0.0",
      version: "1.1.0",
      body: "New release",
      download: state.downloadUpdate,
      install: state.installUpdate,
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

    expect(order).toEqual(["download", "stop", "install"])
    expect(state.invoke).toHaveBeenCalledWith("stop_backend_for_update")
    expect(state.closeUpdate).toHaveBeenCalledOnce()
  })

  it("keeps the backend running when the update download fails", async () => {
    state.downloadUpdate.mockRejectedValueOnce(new Error("network unavailable"))
    state.checkUpdate.mockResolvedValueOnce({
      currentVersion: "1.0.0",
      version: "1.1.0",
      download: state.downloadUpdate,
      install: state.installUpdate,
      close: state.closeUpdate,
    })

    await tauriBridge.checkForUpdate()
    await expect(tauriBridge.installAvailableUpdate()).rejects.toThrow("network unavailable")

    expect(state.invoke).not.toHaveBeenCalledWith("stop_backend_for_update")
    expect(state.installUpdate).not.toHaveBeenCalled()
  })

  it("restarts the backend when the installer cannot start", async () => {
    state.installUpdate.mockRejectedValueOnce(new Error("installer failed"))
    state.checkUpdate.mockResolvedValueOnce({
      currentVersion: "1.0.0",
      version: "1.1.0",
      download: state.downloadUpdate,
      install: state.installUpdate,
      close: state.closeUpdate,
    })

    await tauriBridge.checkForUpdate()
    await expect(tauriBridge.installAvailableUpdate()).rejects.toThrow("installer failed")

    expect(state.invoke.mock.calls).toEqual([["stop_backend_for_update"], ["restart_backend"]])
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
