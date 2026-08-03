import { describe, expect, it } from "vitest"
import { contrastRatio } from "./contrast"

describe("desktop palette", () => {
  it("meets AA for normal text in the paper palette", () => {
    expect(contrastRatio("#212428", "#F5F4F0")).toBeGreaterThanOrEqual(4.5) // text on background
    expect(contrastRatio("#212428", "#FDFCF9")).toBeGreaterThanOrEqual(4.5) // text on panel
    expect(contrastRatio("#6E7176", "#FDFCF9")).toBeGreaterThanOrEqual(4.5) // muted on panel
    expect(contrastRatio("#6E7176", "#F5F4F0")).toBeGreaterThanOrEqual(4.5) // muted on background
    expect(contrastRatio("#475A74", "#FDFCF9")).toBeGreaterThanOrEqual(4.5) // accent on panel
    expect(contrastRatio("#F8F7F3", "#475A74")).toBeGreaterThanOrEqual(4.5) // accent ink
  })

  it("meets AA for semantic colors", () => {
    expect(contrastRatio("#9C4A3D", "#F6E9E5")).toBeGreaterThanOrEqual(4.5) // danger
    expect(contrastRatio("#7C382C", "#F6E9E5")).toBeGreaterThanOrEqual(4.5) // danger ink
    expect(contrastRatio("#775C2F", "#EDEBE4")).toBeGreaterThanOrEqual(4.5) // warning
    expect(contrastRatio("#40674F", "#EDEBE4")).toBeGreaterThanOrEqual(4.5) // success
    expect(contrastRatio("#2B2E33", "#EFEDE6")).toBeGreaterThanOrEqual(4.5) // code text
  })

  it("rejects malformed colors", () => {
    expect(() => contrastRatio("#fff", "#181818")).toThrow("Invalid color")
  })
})
