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
