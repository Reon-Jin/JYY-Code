import { describe, expect, it } from "vitest"
import { contrastRatio } from "./contrast"

describe("desktop palette", () => {
  it("meets AA for normal text", () => {
    expect(contrastRatio("#F2F2F2", "#181818")).toBeGreaterThanOrEqual(4.5)
    expect(contrastRatio("#A1A1A1", "#1F1F1F")).toBeGreaterThanOrEqual(4.5)
  })

  it("rejects malformed colors", () => {
    expect(() => contrastRatio("#fff", "#181818")).toThrow("Invalid color")
  })
})
