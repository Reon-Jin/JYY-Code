import { describe, expect, it } from "vitest"
import { contrastRatio } from "./contrast"

describe("desktop palette", () => {
  it("meets AA for normal text", () => {
    expect(contrastRatio("#F2F2F2", "#181818")).toBeGreaterThanOrEqual(4.5)
    expect(contrastRatio("#A1A1A1", "#1F1F1F")).toBeGreaterThanOrEqual(4.5)
    expect(contrastRatio("#F2F2F2", "#262626")).toBeGreaterThanOrEqual(4.5) // running
    expect(contrastRatio("#D4A72C", "#262626")).toBeGreaterThanOrEqual(4.5) // review
    expect(contrastRatio("#F87171", "#262626")).toBeGreaterThanOrEqual(4.5) // failed
    expect(contrastRatio("#67D391", "#262626")).toBeGreaterThanOrEqual(4.5) // done
  })

  it("meets AA for normal text in the light palette", () => {
    expect(contrastRatio("#202020", "#F7F7F7")).toBeGreaterThanOrEqual(4.5)
    expect(contrastRatio("#666666", "#FFFFFF")).toBeGreaterThanOrEqual(4.5)
    expect(contrastRatio("#202020", "#EDEDED")).toBeGreaterThanOrEqual(4.5)
    expect(contrastRatio("#8A5D00", "#EDEDED")).toBeGreaterThanOrEqual(4.5) // review
    expect(contrastRatio("#B42318", "#EDEDED")).toBeGreaterThanOrEqual(4.5) // failed
    expect(contrastRatio("#16794B", "#EDEDED")).toBeGreaterThanOrEqual(4.5) // done
  })

  it("rejects malformed colors", () => {
    expect(() => contrastRatio("#fff", "#181818")).toThrow("Invalid color")
  })
})
