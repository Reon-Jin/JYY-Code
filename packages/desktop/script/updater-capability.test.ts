import { describe, expect, it } from "bun:test"

const capabilityPath = new URL("../src-tauri/capabilities/main.json", import.meta.url)

describe("desktop updater capability", () => {
  it("allows each updater command used by the desktop bridge", async () => {
    const capability = JSON.parse(await Bun.file(capabilityPath).text()) as { permissions: string[] }

    expect(capability.permissions).toEqual(
      expect.arrayContaining(["updater:allow-check", "updater:allow-download", "updater:allow-install"]),
    )
  })
})
