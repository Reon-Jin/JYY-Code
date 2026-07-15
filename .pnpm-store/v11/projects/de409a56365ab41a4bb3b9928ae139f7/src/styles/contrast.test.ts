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

  it("rejects malformed colors", () => {
    expect(() => contrastRatio("#fff", "#181818")).toThrow("Invalid color")
  })
})
