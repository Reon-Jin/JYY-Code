import { beforeEach, describe, expect, it } from "vitest"
import { createBrowserBridge } from "./browser"

describe("browser desktop settings persistence", () => {
  beforeEach(() => localStorage.clear())

  it("round-trips validated settings", async () => {
    const bridge = createBrowserBridge(localStorage)
    await bridge.saveSettings({ startup: "home", theme: "light" })

    expect(await bridge.loadSettings()).toEqual({ startup: "home", theme: "light" })
  })

  it("recovers from malformed storage", async () => {
    localStorage.setItem("jyycode.desktop.settings", "{not json")
    expect(await createBrowserBridge(localStorage).loadSettings()).toEqual({ startup: "restore", theme: "dark" })

    localStorage.setItem("jyycode.desktop.settings", JSON.stringify({ startup: "bad", theme: "liquid" }))
    expect(await createBrowserBridge(localStorage).loadSettings()).toEqual({ startup: "restore", theme: "dark" })
  })
})
