import { cleanup, render, screen } from "@solidjs/testing-library"
import { afterEach, describe, expect, it } from "vitest"
import { ComposerUsage } from "./composer-usage"

afterEach(cleanup)

describe("composer usage", () => {
  it("shows measured categories and the USD estimate without claiming child or tool totals", () => {
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
    expect(usage).toHaveTextContent("$0.012345")
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
    expect(usage).toHaveTextContent("预估模型费用暂无费用数据")
    expect(screen.queryByRole("tooltip")).not.toBeInTheDocument()
  })
})
