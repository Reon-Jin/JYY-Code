import { describe, expect, it } from "bun:test"
import { tauriBuildEnvironment } from "./build-desktop"

describe("desktop build environment", () => {
  it("uses Tauri's non-interactive DMG path on macOS", () => {
    expect(tauriBuildEnvironment("darwin", { CI: "false" }).CI).toBe("true")
  })

  it("does not change the Windows build environment", () => {
    expect(tauriBuildEnvironment("win32", { CI: "false" }).CI).toBe("false")
  })
})
