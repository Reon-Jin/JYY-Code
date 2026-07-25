import { tr } from "../../i18n/i18n-context"
import { Show, type JSX } from "solid-js"
import type { ComposerUsageMetrics } from "./usage-metrics"

const exactNumber = new Intl.NumberFormat("zh-CN")
const compactNumber = new Intl.NumberFormat("zh-CN", { notation: "compact", maximumFractionDigits: 1 })
const usdToCnyRate = 7.2
const money = new Intl.NumberFormat("zh-CN", {
  style: "currency",
  currency: "CNY",
  minimumFractionDigits: 4,
  maximumFractionDigits: 6,
})

function compact(value: number | undefined) {
  return value === undefined ? tr("composer.no-data-yet") : compactNumber.format(value)
}

function exact(value: number) {
  return exactNumber.format(value)
}

export function ComposerUsage(props: { metrics: ComposerUsageMetrics; permissionControl?: JSX.Element }) {
  const contextLabel = () => {
    const used = props.metrics.contextUsed
    const limit = props.metrics.contextWindow
    if (used === undefined) return tr("composer.no-data-yet")
    return limit === undefined ? compact(used) : `${compact(used)} / ${compact(limit)}`
  }

  return (
    <div class="composer-usage" aria-label={tr("composer.session-usage")}>
      <div class="composer-usage__item composer-usage__permission">{props.permissionControl}</div>
      <div class="composer-usage__item composer-usage__context">
        <span>{tr("composer.window-usage")}</span>
        <strong>
          {contextLabel()}
          <Show when={props.metrics.contextPercent !== undefined}>
            {` · ${props.metrics.contextPercent!.toFixed(1)}%`}
          </Show>
        </strong>
        <span class="composer-usage__track" aria-hidden="true">
          <span style={{ width: `${props.metrics.contextPercent ?? 0}%` }} />
        </span>
      </div>
      <Show when={props.metrics.aggregate} keyed>
        {(aggregate) => (
          <>
            <div
              class="composer-usage__item composer-usage__tokens"
              tabIndex={0}
              aria-describedby="composer-token-breakdown"
            >
              <span>{tr("composer.main-sub-agent-token")}</span>
              <strong>{compact(aggregate.tokens.total)}</strong>
              <div id="composer-token-breakdown" class="composer-usage__popover" role="tooltip">
                <strong>{tr("composer.token-source")}</strong>
                <dl>
                  <div>
                    <dt>{tr("composer.enter")}</dt>
                    <dd>{exact(aggregate.tokens.input)}</dd>
                  </div>
                  <div>
                    <dt>{tr("composer.output")}</dt>
                    <dd>{exact(aggregate.tokens.output)}</dd>
                  </div>
                  <div>
                    <dt>{tr("composer.think")}</dt>
                    <dd>{exact(aggregate.tokens.reasoning)}</dd>
                  </div>
                  <div>
                    <dt>{tr("composer.tool-call")}</dt>
                    <dd>{tr("composer.included-in-input-output-provider-not-listed-separately")}</dd>
                  </div>
                  <div>
                    <dt>{tr("composer.subagent")}</dt>
                    <dd>{exact(aggregate.tokens.subagents)}</dd>
                  </div>
                  <div>
                    <dt>{tr("composer.others-cache")}</dt>
                    <dd>{exact(aggregate.tokens.other)}</dd>
                  </div>
                  <div class="composer-usage__total">
                    <dt>{tr("composer.total")}</dt>
                    <dd>{exact(aggregate.tokens.total)}</dd>
                  </div>
                </dl>
              </div>
            </div>
            <div class="composer-usage__item">
              <span>{tr("composer.api-consumption")}</span>
              <strong>{money.format(aggregate.cost * usdToCnyRate)}</strong>
            </div>
          </>
        )}
      </Show>
    </div>
  )
}
