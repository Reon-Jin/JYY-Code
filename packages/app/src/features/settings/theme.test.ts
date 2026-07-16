import { afterEach, describe, expect, it } from "vitest"
import { applyTheme } from "./theme"

afterEach(() => {
  delete document.documentElement.dataset.theme
})

describe("applyTheme", () => {
  it("applies the selected theme to the document root", () => {
    applyTheme("light", document.documentElement)
    expect(document.documentElement.dataset.theme).toBe("light")

    applyTheme("dark", document.documentElement)
    expect(document.documentElement.dataset.theme).toBe("dark")
  })
})
