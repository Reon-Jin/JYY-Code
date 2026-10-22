import { cleanup, render, screen } from "@solidjs/testing-library"
import { afterEach, describe, expect, it } from "vitest"
import { ComposerUsage } from "./composer-usage"
import { publishUsdToCny } from "./cost-currency"
import { DEFAULT_USD_TO_CNY } from "../settings/settings-preferences"
import { createSignal } from "solid-js"

afterEach(() => {
  cleanup()
  publishUsdToCny(DEFAULT_USD_TO_CNY)
})

describe("composer usage", () => {
  it("keeps the token popover and its focused trigger mounted while streaming usage updates", () => {
    const usage = (output: number) => ({
      aggregate: { tokens: { input: 1000, output, reasoning: 0, cache: 0, total: 1000 + output }, cost: 0.01 },
    })
    const [metrics, setMetrics] = createSignal(usage(200))
    render(() => <ComposerUsage metrics={metrics()} />)
    const breakdown = screen.getByRole("tooltip")
    const trigger = breakdown.closest<HTMLElement>(".composer-usage__tokens")!
    trigger.focus()
    for (let output = 201; output <= 220; output++) {
      setMetrics(usage(output))
      expect(screen.getByRole("tooltip")).toBe(breakdown)
      expect(trigger).toHaveFocus()
    }
    expect(breakdown).toHaveTextContent("输出220")
    expect(breakdown).toHaveTextContent("总计1,220")
  })
  it("explicitly labels totals for the root and all child agents", () => {
    render(() => (
      <ComposerUsage
        metrics={{
          aggregateScope: "tree",
          agentCount: 4,
          aggregate: { tokens: { input: 1000, output: 200, reasoning: 0, cache: 0, total: 1200 }, cost: 0.4 },
        }}
      />
    ))
    expect(screen.getByLabelText("会话用量")).toHaveTextContent("全部 Agent Token")
    expect(screen.getByRole("tooltip")).toHaveTextContent("主 Agent + 所有子 Agent，共 4 个会话")
    expect(screen.getByLabelText("会话用量")).toHaveTextContent("¥2.67044")
  })
  it("shows measured categories and converts USD billing to a CNY estimate", () => {
    render(() => (
      <ComposerUsage
        metrics={{
          aggregate: {
            tokens: { input: 1_000, output: 200, reasoning: 0, cache: 30, total: 1_230 },
            cost: 0.012345,
          },
        }}
      />
    ))

    const usage = screen.getByLabelText("会话用量")
    const breakdown = screen.getByRole("tooltip")
    expect(usage).toHaveTextContent("本会话 Token")
    expect(usage).toHaveTextContent("¥0.082416")
    expect(breakdown).toHaveTextContent("输入1,000")
    expect(breakdown).toHaveTextContent("输出200")
    expect(breakdown).toHaveTextContent("缓存30")
    expect(breakdown).not.toHaveTextContent("思考")
    expect(breakdown).not.toHaveTextContent("子智能体")
    expect(breakdown).not.toHaveTextContent("工具调用")
  })

  it("labels absent token and pricing information instead of rendering false zeroes", () => {
    render(() => (
      <ComposerUsage
        metrics={{ aggregate: { tokens: { input: 0, output: 0, reasoning: 0, cache: 0, total: 0 }, cost: 0 } }}
      />
    ))

    const usage = screen.getByLabelText("会话用量")
    expect(usage).toHaveTextContent("本会话 Token暂无数据")
    expect(usage).toHaveTextContent("预估模型费用（人民币）暂无费用数据")
    expect(screen.queryByRole("tooltip")).not.toBeInTheDocument()
  })
  it("updates the RMB estimate immediately when the configured exchange rate changes", () => {
    publishUsdToCny(7)
    render(() => (
      <ComposerUsage
        metrics={{ aggregate: { tokens: { input: 1, output: 0, reasoning: 0, cache: 0, total: 1 }, cost: 2 } }}
      />
    ))
    expect(screen.getByLabelText("会话用量")).toHaveTextContent("¥14.0000")
    publishUsdToCny(6.5)
    expect(screen.getByLabelText("会话用量")).toHaveTextContent("¥13.0000")
    expect(screen.getByLabelText("会话用量")).not.toHaveTextContent("换算")
  })
  it("does not round very small RMB charges down to zero", () => {
    render(() => (
      <ComposerUsage
        metrics={{ aggregate: { tokens: { input: 1, output: 0, reasoning: 0, cache: 0, total: 1 }, cost: 1e-9 } }}
      />
    ))
    expect(screen.getByLabelText("会话用量")).toHaveTextContent("<¥0.000001")
  })
})
