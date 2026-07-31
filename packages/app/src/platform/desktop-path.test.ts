import { describe, expect, it } from "vitest"
import { defaultShellOptions, desktopPathStyle, directoryName, normalizeDirectory } from "./desktop-path"

describe("desktop paths", () => {
  it("keeps startup resilient while a persisted project path is unavailable", () => {
    expect(desktopPathStyle(undefined)).toBe("posix")
    expect(normalizeDirectory(undefined)).toBe("")
    expect(directoryName(undefined)).toBe("")
    expect(defaultShellOptions(undefined)).toContain("bash")
  })
})
