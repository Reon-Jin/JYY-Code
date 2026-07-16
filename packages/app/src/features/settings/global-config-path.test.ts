import { describe, expect, it } from "vitest"
import { globalConfigPath } from "./global-config-path"

describe("globalConfigPath", () => {
  it("uses the backend config directory on Windows and POSIX", () => {
    expect(globalConfigPath("C:\\Users\\dev\\.config\\jyycode")).toBe(
      "C:\\Users\\dev\\.config\\jyycode\\jyycode.jsonc",
    )
    expect(globalConfigPath("/home/dev/.config/jyycode/")).toBe("/home/dev/.config/jyycode/jyycode.jsonc")
  })
})
