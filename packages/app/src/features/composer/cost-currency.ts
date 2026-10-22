import { createSignal } from "solid-js"
import { DEFAULT_USD_TO_CNY, validUsdToCny } from "../settings/settings-preferences"

// Provider catalog prices and persisted billing ledgers are denominated in USD.
// Convert exactly once at display time, after aggregating every agent's cost.
const [usdToCny, setUsdToCny] = createSignal(DEFAULT_USD_TO_CNY)
export { usdToCny }

export function publishUsdToCny(value: unknown) {
  setUsdToCny(validUsdToCny(value) ? value : DEFAULT_USD_TO_CNY)
}
