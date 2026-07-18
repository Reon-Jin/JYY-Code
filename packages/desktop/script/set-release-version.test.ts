import { afterEach, describe, expect, it } from "bun:test"
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { setDesktopReleaseVersion } from "./set-release-version"

const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { force: true, recursive: true })
})

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "jyycode-desktop-version-"))
  roots.push(root)
  const desktop = join(root, "packages", "desktop")
  const tauri = join(desktop, "src-tauri")
  mkdirSync(tauri, { recursive: true })
  writeFileSync(join(desktop, "package.json"), '{"name":"desktop","version":"1.0.0"}\n')
  writeFileSync(join(tauri, "tauri.conf.json"), '{"productName":"JYYCode","version":"1.0.0"}\n')
  writeFileSync(join(tauri, "Cargo.toml"), '[package]\nname = "jyycode-desktop"\nversion = "1.0.0"\n')
  writeFileSync(join(tauri, "Cargo.lock"), '[[package]]\nname = "jyycode-desktop"\nversion = "1.0.0"\n')
  return root
}

describe("setDesktopReleaseVersion", () => {
  it("updates every Desktop-owned version source", () => {
    const root = fixture()
    setDesktopReleaseVersion("1.2.3-beta.1", root)

    expect(JSON.parse(readFileSync(join(root, "packages/desktop/package.json"), "utf8")).version).toBe("1.2.3-beta.1")
    expect(JSON.parse(readFileSync(join(root, "packages/desktop/src-tauri/tauri.conf.json"), "utf8")).version).toBe("1.2.3-beta.1")
    expect(readFileSync(join(root, "packages/desktop/src-tauri/Cargo.toml"), "utf8")).toContain('version = "1.2.3-beta.1"')
    expect(readFileSync(join(root, "packages/desktop/src-tauri/Cargo.lock"), "utf8")).toContain('version = "1.2.3-beta.1"')
  })

  it("rejects an invalid version before changing files", () => {
    expect(() => setDesktopReleaseVersion("v1.2", fixture())).toThrow("Invalid Desktop version")
  })
})
