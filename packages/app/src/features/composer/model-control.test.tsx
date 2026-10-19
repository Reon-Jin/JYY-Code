import type { CatalogModel, ModelSelection } from "./model-catalog"
import { cleanup, render, screen, waitFor } from "@solidjs/testing-library"
import userEvent from "@testing-library/user-event"
import { createSignal } from "solid-js"
import { afterEach, describe, expect, it } from "vitest"
import { ModelControl } from "./model-control"

const models: readonly CatalogModel[] = [
  {
    providerID: "openai",
    providerName: "OpenAI",
    modelID: "gpt-5",
    modelName: "GPT-5",
    contextWindow: 128_000,
    variants: ["high"],
  },
  {
    providerID: "openai",
    providerName: "OpenAI",
    modelID: "gpt-4.1",
    modelName: "GPT-4.1",
    contextWindow: 128_000,
    variants: [],
  },
]

afterEach(cleanup)

describe("ModelControl", () => {
  it("applies reasoning depth changes and clears them when switching models", async () => {
    const user = userEvent.setup()
    const [value, setValue] = createSignal<ModelSelection>({ providerID: "openai", modelID: "gpt-5" })
    render(() => <ModelControl models={models} value={value()} onChange={setValue} />)

    await user.click(screen.getByLabelText("配置模型"))
    const depth = screen.getByRole("combobox", { name: "思考深度" })
    await user.selectOptions(depth, "high")
    expect(value()).toEqual({ providerID: "openai", modelID: "gpt-5", variant: "high" })
    await user.click(screen.getByRole("button", { name: "完成" }))
    await user.click(screen.getByLabelText("配置模型"))
    expect(screen.getByRole("combobox", { name: "思考深度" })).toHaveValue("high")
    await user.selectOptions(screen.getByRole("combobox", { name: "思考深度" }), "")
    expect(value()).toEqual({ providerID: "openai", modelID: "gpt-5" })
    await user.selectOptions(screen.getByRole("combobox", { name: "思考深度" }), "high")
    await user.selectOptions(screen.getByRole("combobox", { name: "模型" }), "openai/gpt-4.1")
    expect(value()).toEqual({ providerID: "openai", modelID: "gpt-4.1" })
    expect(screen.getByRole("combobox", { name: "思考深度" })).toHaveValue("")
  })

  it("keeps the selected model after a parent update", async () => {
    const user = userEvent.setup()
    const [value, setValue] = createSignal<ModelSelection>({ providerID: "openai", modelID: "gpt-5" })
    const [renderCount, setRenderCount] = createSignal(0)

    render(() => (
      <>
        <output>{renderCount()}</output>
        <ModelControl models={models} value={value()} onChange={setValue} />
      </>
    ))

    await user.click(screen.getByLabelText("配置模型"))
    const selector = screen.getByRole("combobox", { name: "模型" })
    await user.selectOptions(selector, "openai/gpt-4.1")
    expect(selector).toHaveValue("openai/gpt-4.1")

    setRenderCount(1)
    await waitFor(() => expect(selector).toHaveValue("openai/gpt-4.1"))
  })
})
