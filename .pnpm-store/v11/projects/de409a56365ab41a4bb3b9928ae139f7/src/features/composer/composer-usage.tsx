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
  return value === undefined ? "暂无数据" : compactNumber.format(value)
}

function exact(value: number) {
  return exactNumber.format(value)
}

export function ComposerUsage(props: { metrics: ComposerUsageMetrics; permissionControl?: JSX.Element }) {
  const contextLabel = () => {
    const used = props.metrics.contextUsed
    const limit = props.metrics.contextWindow
    if (used === undefined) return "暂无数据"
    return limit === undefined ? compact(used) : `${compact(used)} / ${compact(limit)}`
  }

  return (
    <div class="composer-usage" aria-label="会话用量">
      <div class="composer-usage__item composer-usage__permission">{props.permissionControl}</div>
      <div class="composer-usage__item composer-usage__context">
        <span>窗口使用情况</span>
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
              <span>主 + 子智能体 Token</span>
              <strong>{compact(aggregate.tokens.total)}</strong>
              <div id="composer-token-breakdown" class="composer-usage__popover" role="tooltip">
                <strong>Token 来源</strong>
                <dl>
                  <div><dt>输入</dt><dd>{exact(aggregate.tokens.input)}</dd></div>
                  <div><dt>输出</dt><dd>{exact(aggregate.tokens.output)}</dd></div>
                  <div><dt>思考</dt><dd>{exact(aggregate.tokens.reasoning)}</dd></div>
                  <div><dt>工具调用</dt><dd>已计入输入/输出，提供商未单列</dd></div>
                  <div><dt>子智能体</dt><dd>{exact(aggregate.tokens.subagents)}</dd></div>
                  <div><dt>其它（缓存）</dt><dd>{exact(aggregate.tokens.other)}</dd></div>
                  <div class="composer-usage__total"><dt>总计</dt><dd>{exact(aggregate.tokens.total)}</dd></div>
                </dl>
              </div>
            </div>
            <div class="composer-usage__item">
              <span>API 消费</span>
              <strong>{money.format(aggregate.cost * usdToCnyRate)}</strong>
            </div>
          </>
        )}
      </Show>
    </div>
  )
}
