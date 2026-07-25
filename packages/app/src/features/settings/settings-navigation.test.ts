import { describe, expect, it } from "vitest"
import { memorySettingsHref, sanitizeSettingsReturnTo, settingsHref } from "./settings-navigation"

describe("settings navigation", () => {
  it("accepts only supported internal return routes", () => {
    expect(sanitizeSettingsReturnTo("https://example.com")).toBe("/")
    expect(sanitizeSettingsReturnTo("/settings/general")).toBe("/")
    expect(sanitizeSettingsReturnTo("/session/ses_1")).toBe("/session/ses_1")
    expect(sanitizeSettingsReturnTo("/workspace")).toBe("/workspace")
    expect(sanitizeSettingsReturnTo("/")).toBe("/")
  })

  it("encodes a sanitized return route", () => {
    expect(settingsHref("general", "/session/ses_1")).toBe("/settings/general?returnTo=%2Fsession%2Fses_1")
    expect(settingsHref("security", "https://example.com")).toBe("/settings/security?returnTo=%2F")
    expect(memorySettingsHref("task", "/workspace")).toBe("/settings/memory/task?returnTo=%2Fworkspace")
  })
})
