import { describe, expect, it } from "vitest"
import { contrastRatio } from "./contrast"

describe("desktop palette", () => {
  it("meets AA for normal text", () => {
    expect(contrastRatio("#E7EEF7", "#07111F")).toBeGreaterThanOrEqual(4.5)
    expect(contrastRatio("#8DA2B8", "#0B192B")).toBeGreaterThanOrEqual(4.5)
  })

  it("rejects malformed colors", () => {
    expect(() => contrastRatio("#fff", "#07111F")).toThrow("Invalid color")
  })
})
