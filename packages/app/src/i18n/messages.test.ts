import { describe, expect, it } from "vitest"
import { enUS } from "./messages"

describe("English message catalog", () => {
  it("contains no residual Han-script text", () => {
    const residual = Object.entries(enUS)
      .filter(([, message]) => /\p{Script=Han}/u.test(message))
      .map(([key]) => key)

    expect(residual).toEqual([])
  })
})
