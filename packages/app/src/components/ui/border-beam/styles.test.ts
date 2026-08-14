import { describe, expect, it } from "vitest"
import { getPulseDriverConfig } from "./styles"

describe("getPulseDriverConfig", () => {
  it("does not register the JavaScript frame driver for ordinary beams", () => {
    expect(getPulseDriverConfig("md", "light", 1.96, 30, false, "beam-1")).toBeNull()
  })

  it("keeps the JavaScript driver for pulse beams", () => {
    const config = getPulseDriverConfig("pulse-outside", "dark", 2.3, 30, false, "beam-2")

    expect(config).not.toBeNull()
    expect(config?.oscillators.length).toBeGreaterThan(0)
    expect(config?.hue?.prop).toBe("--beam-hue-beam-2")
  })
})
