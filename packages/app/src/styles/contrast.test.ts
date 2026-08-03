import { describe, expect, it } from "vitest"
import { contrastRatio } from "./contrast"

describe("desktop palette", () => {
  it("meets AA for normal text in the paper palette", () => {
    expect(contrastRatio("#212428", "#EFEDE7")).toBeGreaterThanOrEqual(4.5) // text on background
    expect(contrastRatio("#212428", "#F7F5EF")).toBeGreaterThanOrEqual(4.5) // text on panel
    expect(contrastRatio("#686A6F", "#F7F5EF")).toBeGreaterThanOrEqual(4.5) // muted on panel
    expect(contrastRatio("#686A6F", "#EFEDE7")).toBeGreaterThanOrEqual(4.5) // muted on background
    expect(contrastRatio("#475A74", "#F7F5EF")).toBeGreaterThanOrEqual(4.5) // accent on panel
    expect(contrastRatio("#F8F7F3", "#475A74")).toBeGreaterThanOrEqual(4.5) // accent ink
  })

  it("meets AA for semantic colors", () => {
    expect(contrastRatio("#9C4A3D", "#F6E9E5")).toBeGreaterThanOrEqual(4.5) // danger
    expect(contrastRatio("#7C382C", "#F6E9E5")).toBeGreaterThanOrEqual(4.5) // danger ink
    expect(contrastRatio("#775C2F", "#E7E4DA")).toBeGreaterThanOrEqual(4.5) // warning
    expect(contrastRatio("#40674F", "#E7E4DA")).toBeGreaterThanOrEqual(4.5) // success
    expect(contrastRatio("#2B2E33", "#E9E6DA")).toBeGreaterThanOrEqual(4.5) // code text
  })

  it("rejects malformed colors", () => {
    expect(() => contrastRatio("#fff", "#181818")).toThrow("Invalid color")
  })
})
