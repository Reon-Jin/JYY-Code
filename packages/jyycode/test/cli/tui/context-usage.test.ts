import { expect, test } from "bun:test"
import { formatContextUsage } from "../../../src/cli/cmd/tui/util/context-usage"

test("labels provider usage separately from estimated active context", () => {
  const result = formatContextUsage({
    providerTokens: 20_000,
    estimatedTokens: 120_000,
    contextLimit: 1_000_000,
  })

  expect(result.provider).toBe("20,000 provider tokens (2%)")
  expect(result.estimated).toBe("120,000 estimated active context (12%)")
})
