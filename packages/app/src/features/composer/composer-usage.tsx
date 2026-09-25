import { tr } from "../../i18n/i18n-context"
import { Show, type JSX } from "solid-js"
import type { ComposerUsageMetrics } from "./usage-metrics"

const exactNumber = new Intl.NumberFormat("zh-CN")
const compactNumber = new Intl.NumberFormat("zh-CN", { notation: "compact", maximumFractionDigits: 1 })
const money = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
  minimumFractionDigits: 4,
  maximumFractionDigits: 6,
})

function compact(value: number | undefined) {
  return value === undefined ? tr("composer.no-data-yet") : compactNumber.format(value)
}

function exact(value: number) {
  return exactNumber.format(value)
}

function estimatedCost(value: number) {
  if (!Number.isFinite(value) || value <= 0) return tr("composer.no-pricing-data")
  return value < 0.000001 ? "<$0.000001" : money.format(value)
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
            <div class="composer-usage__item composer-usage__tokens"
              tabIndex={aggregate.tokens.total > 0 ? 0 : undefined}
              aria-describedby={aggregate.tokens.total > 0 ? "composer-token-breakdown" : undefined}
            >
              <span>{tr("composer.session-token")}</span>
              <strong>{aggregate.tokens.total > 0 ? compact(aggregate.tokens.total) : tr("composer.no-data-yet")}</strong>
              <Show when={aggregate.tokens.total > 0}>
                <div id="composer-token-breakdown" class="composer-usage__popover" role="tooltip">
                  <strong>{tr("composer.token-source")}</strong>
                  <dl>
                    <Show when={aggregate.tokens.input > 0}>
                      <div>
                        <dt>{tr("composer.enter")}</dt>
                        <dd>{exact(aggregate.tokens.input)}</dd>
                      </div>
                    </Show>
                    <Show when={aggregate.tokens.output > 0}>
                      <div>
                        <dt>{tr("composer.output")}</dt>
                        <dd>{exact(aggregate.tokens.output)}</dd>
                      </div>
                    </Show>
                    <Show when={aggregate.tokens.reasoning > 0}>
                      <div>
                        <dt>{tr("composer.think")}</dt>
                        <dd>{exact(aggregate.tokens.reasoning)}</dd>
                      </div>
                    </Show>
                    <Show when={aggregate.tokens.cache > 0}>
                      <div>
                        <dt>{tr("composer.cache")}</dt>
                        <dd>{exact(aggregate.tokens.cache)}</dd>
                      </div>
                    </Show>
                    <div class="composer-usage__total">
                      <dt>{tr("composer.total")}</dt>
                      <dd>{exact(aggregate.tokens.total)}</dd>
                    </div>
                  </dl>
                </div>
              </Show>
            </div>
            <div class="composer-usage__item">
              <span>{tr("composer.api-consumption")}</span>
              <strong>{estimatedCost(aggregate.cost)}</strong>
            </div>
          </>
        )}
      </Show>
    </div>
  )
}
