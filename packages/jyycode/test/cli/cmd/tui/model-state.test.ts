import { describe, expect, test } from "bun:test"
import { decodeModelState, encodeModelState } from "../../../../src/cli/cmd/tui/context/model-state"

describe("TUI model state", () => {
  test("round-trips active per-agent model selections", () => {
    const encoded = encodeModelState({
      model: { build: { providerID: "deepseek", modelID: "deepseek-v4-flash" } },
      recent: [{ providerID: "deepseek", modelID: "deepseek-v4-flash" }],
      favorite: [],
      variant: {},
    })

    expect(decodeModelState(encoded)).toEqual({
      model: { build: { providerID: "deepseek", modelID: "deepseek-v4-flash" } },
      recent: [{ providerID: "deepseek", modelID: "deepseek-v4-flash" }],
      favorite: [],
      variant: {},
    })
  })

  test("drops malformed active model entries", () => {
    expect(
      decodeModelState({
        model: {
          build: { providerID: "deepseek", modelID: "deepseek-v4-pro" },
          broken: { providerID: "anthropic" },
        },
      }).model,
    ).toEqual({ build: { providerID: "deepseek", modelID: "deepseek-v4-pro" } })
  })
})
