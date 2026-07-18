import { describe, expect, it } from "vitest"
import { defaultShellOptions, desktopPathStyle, directoryName, normalizeDirectory } from "./desktop-path"

describe("desktop paths", () => {
  it("normalizes Windows separators and case while preserving the drive root", () => {
    expect(desktopPathStyle("C:\\Work\\Demo")).toBe("windows")
    expect(normalizeDirectory("C:/Work/Demo/")).toBe("c:\\work\\demo")
    expect(normalizeDirectory("C:\\")).toBe("c:\\")
    expect(directoryName("C:/Work/Demo/")).toBe("Demo")
  })

  it("keeps POSIX paths case-sensitive and preserves backslashes", () => {
    expect(desktopPathStyle("/Users/dev/Work")).toBe("posix")
    expect(normalizeDirectory("/Users/dev/Work/")).toBe("/Users/dev/Work")
    expect(normalizeDirectory("/Users/dev/work")).not.toBe(normalizeDirectory("/Users/dev/Work"))
    expect(normalizeDirectory(String.raw`/Users/dev/a\b/`)).toBe(String.raw`/Users/dev/a\b`)
    expect(normalizeDirectory("/")).toBe("/")
    expect(directoryName(String.raw`/Users/dev/a\b/`)).toBe(String.raw`a\b`)
  })

  it("offers platform-appropriate default shells", () => {
    expect(defaultShellOptions("C:\\Users\\dev")).toEqual(["pwsh", "powershell", "cmd", "bash"])
    expect(defaultShellOptions("/Users/dev")).toEqual(["zsh", "bash"])
  })
})
