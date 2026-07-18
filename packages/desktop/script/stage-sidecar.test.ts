import { describe, expect, it } from "bun:test"
import { sidecarName, sidecarTarget, sourceBinary } from "./stage-sidecar"

describe("sidecar staging", () => {
  it("uses Tauri's Windows x64 target-triple suffix", () => {
    expect(sidecarName("win32", "x64")).toBe("jyycode-sidecar-x86_64-pc-windows-msvc.exe")
  })

  it("selects the existing Bun-compiled Windows binary", () => {
    expect(
      sourceBinary("win32", "x64")
        .replaceAll("\\", "/")
        .endsWith("/packages/jyycode/dist/jyycode-windows-x64/bin/jyycode.exe"),
    ).toBe(true)
  })

  it("uses Tauri's Apple Silicon target-triple suffix", () => {
    expect(sidecarName("darwin", "arm64")).toBe("jyycode-sidecar-aarch64-apple-darwin")
  })

  it("selects the existing Bun-compiled Apple Silicon binary", () => {
    expect(
      sourceBinary("darwin", "arm64")
        .replaceAll("\\", "/")
        .endsWith("/packages/jyycode/dist/jyycode-darwin-arm64/bin/jyycode"),
    ).toBe(true)
  })

  it("rejects unsupported desktop targets", () => {
    expect(() => sidecarTarget("darwin", "x64")).toThrow("Unsupported desktop target: darwin/x64")
    expect(() => sidecarTarget("linux", "arm64")).toThrow("Unsupported desktop target: linux/arm64")
  })
})
