import { describe, expect, test } from "bun:test"
import { explicitlySelectableProviders } from "../../src/provider/selectable"

describe("explicitlySelectableProviders", () => {
  const providers = {
    anthropic: { id: "anthropic", name: "Anthropic" },
    deepseek: { id: "deepseek", name: "DeepSeek" },
  }

  test("hides environment-only providers when an explicit connection exists", () => {
    expect(Object.keys(explicitlySelectableProviders(providers, ["deepseek"], []))).toEqual(["deepseek"])
  })

  test("includes configured providers and preserves environment-only fallback", () => {
    expect(Object.keys(explicitlySelectableProviders(providers, [], ["anthropic"]))).toEqual(["anthropic"])
    expect(Object.keys(explicitlySelectableProviders(providers, [], []))).toEqual(["anthropic", "deepseek"])
  })
})
