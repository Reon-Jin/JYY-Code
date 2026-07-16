import { describe, expect, it } from "bun:test"
import { createUpdateManifest } from "./create-update-manifest"

describe("createUpdateManifest", () => {
  it("creates a signed Windows x64 static manifest", () => {
    expect(createUpdateManifest({
      version: "1.0.0",
      repository: "Reon-Jin/JYY-Code",
      tag: "desktop-v1.0.0",
      installerName: "JYYCode_1.0.0_x64-setup.exe",
      signature: "trusted-signature",
      notes: "JYYCode Desktop 1.0.0",
      pubDate: "2026-07-16T12:00:00.000Z",
    })).toEqual({
      version: "1.0.0",
      notes: "JYYCode Desktop 1.0.0",
      pub_date: "2026-07-16T12:00:00.000Z",
      platforms: {
        "windows-x86_64": {
          signature: "trusted-signature",
          url: "https://github.com/Reon-Jin/JYY-Code/releases/download/desktop-v1.0.0/JYYCode_1.0.0_x64-setup.exe",
        },
      },
    })
  })

  it("rejects an invalid release version or empty signature", () => {
    const valid = {
      version: "1.0.0",
      repository: "Reon-Jin/JYY-Code",
      tag: "desktop-v1.0.0",
      installerName: "setup.exe",
      signature: "signature",
      notes: "notes",
      pubDate: "2026-07-16T12:00:00.000Z",
    }
    expect(() => createUpdateManifest({ ...valid, version: "latest" })).toThrow("Invalid version")
    expect(() => createUpdateManifest({ ...valid, signature: "" })).toThrow("Signature is empty")
  })
})
