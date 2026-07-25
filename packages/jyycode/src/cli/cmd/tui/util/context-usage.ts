const fmt = new Intl.NumberFormat("en-US")

function pct(tokens: number, limit: number | undefined) {
  return limit ? `${Math.round((tokens / limit) * 100)}%` : undefined
}

export function formatContextUsage(input: {
  providerTokens?: number
  estimatedTokens?: number
  contextLimit?: number
}) {
  const providerPct = input.providerTokens === undefined ? undefined : pct(input.providerTokens, input.contextLimit)
  const estimatedPct = input.estimatedTokens === undefined ? undefined : pct(input.estimatedTokens, input.contextLimit)
  return {
    provider:
      input.providerTokens === undefined
        ? undefined
        : `${fmt.format(input.providerTokens)} provider tokens${providerPct ? ` (${providerPct})` : ""}`,
    estimated:
      input.estimatedTokens === undefined
        ? undefined
        : `${fmt.format(input.estimatedTokens)} estimated active context${estimatedPct ? ` (${estimatedPct})` : ""}`,
  }
}
