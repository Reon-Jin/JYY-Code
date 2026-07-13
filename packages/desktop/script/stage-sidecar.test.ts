import { describe, expect, it } from "bun:test"
import { sidecarName, sourceBinary } from "./stage-sidecar"

describe("sidecar staging", () => {
  it("uses Tauri's Windows x64 target-triple suffix", () => {
    expect(sidecarName("x64")).toBe("jyycode-sidecar-x86_64-pc-windows-msvc.exe")
  })

  it("selects the existing Bun-compiled Windows binary", () => {
    expect(
      sourceBinary("x64").replaceAll("\\", "/").endsWith("/packages/jyycode/dist/jyycode-windows-x64/bin/jyycode.exe"),
    ).toBe(true)
  })
})
