import { beforeEach, describe, expect, it, vi } from "vitest"

const state = vi.hoisted(() => ({
  values: new Map<string, unknown>(),
  save: vi.fn(async () => undefined),
  invoke: vi.fn(async () => undefined),
}))

vi.mock("@tauri-apps/api/core", () => ({ invoke: state.invoke }))
vi.mock("@tauri-apps/plugin-dialog", () => ({ open: vi.fn() }))
vi.mock("@tauri-apps/plugin-store", () => ({
  Store: {
    load: vi.fn(async () => ({
      get: async (key: string) => state.values.get(key),
      set: async (key: string, value: unknown) => state.values.set(key, structuredClone(value)),
      save: state.save,
    })),
  },
}))

import { tauriBridge } from "./tauri"

describe("Tauri desktop settings persistence", () => {
  beforeEach(() => {
    state.values.clear()
    state.save.mockClear()
    state.invoke.mockClear()
  })

  it("round-trips settings through desktop.json", async () => {
    await tauriBridge.saveSettings({ startup: "home", theme: "light" })

    expect(state.values.get("settings")).toEqual({ startup: "home", theme: "light" })
    expect(state.save).toHaveBeenCalledOnce()
    expect(await tauriBridge.loadSettings()).toEqual({ startup: "home", theme: "light" })
  })

  it("passes config reveal as a command argument", async () => {
    await tauriBridge.revealConfigFile("C:\\Users\\dev\\.config\\jyycode\\jyycode.jsonc")

    expect(state.invoke).toHaveBeenCalledWith("reveal_config_file", {
      path: "C:\\Users\\dev\\.config\\jyycode\\jyycode.jsonc",
    })
  })
})
