import { describe, expect, test } from "bun:test"
import { packageDependencyVersion } from "../src/installation/version"

describe("packageDependencyVersion", () => {
  test("omits unpublished local and preview build versions", () => {
    expect(packageDependencyVersion("local", true)).toBeUndefined()
    expect(packageDependencyVersion("0.0.0-codex/desktop-workspace-202607131405", false)).toBeUndefined()
  })

  test("keeps published release versions pinned", () => {
    expect(packageDependencyVersion("1.15.10", false)).toBe("1.15.10")
  })
})
