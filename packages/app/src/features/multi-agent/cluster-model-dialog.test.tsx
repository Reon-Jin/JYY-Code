import type { AgentClusterConfig } from "@jyycode-ai/sdk/v2/client"
import { cleanup, fireEvent, render, screen, waitFor, within } from "@solidjs/testing-library"
import userEvent from "@testing-library/user-event"
import { createDesktopQueryClient } from "../../data/query-client"
import { keys } from "../../data/query-keys"
import type { CatalogModel } from "../composer/model-catalog"
import { createFakeJyycode } from "../../test/fake-jyycode"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import {
  clusterModelLabel,
  clusterModelRoles,
  formatClusterModelValue,
  parseClusterModelValue,
  resolveClusterModel,
} from "./cluster-model-config"
import { ClusterModelControl } from "./cluster-model-control"

const models: CatalogModel[] = [
  {
    providerID: "test",
    providerName: "Test",
    modelID: "planner",
    modelName: "Planner",
    contextWindow: 100_000,
    variants: ["low", "high"],
  },
  {
    providerID: "test",
    providerName: "Test",
    modelID: "simple",
    modelName: "Simple",
    contextWindow: 100_000,
    variants: [],
  },
  {
    providerID: "test",
    providerName: "Test",
    modelID: "complex",
    modelName: "Complex",
    contextWindow: 100_000,
    variants: ["high"],
  },
  {
    providerID: "test",
    providerName: "Test",
    modelID: "visual",
    modelName: "Visual",
    contextWindow: 100_000,
    variants: [],
  },
  {
    providerID: "other",
    providerName: "Other",
    modelID: "planner",
    modelName: "Planner 2",
    contextWindow: 100_000,
    variants: [],
  },
]

const config: AgentClusterConfig = {
  enabled: true,
  default_on: false,
  planner_model: "test/planner",
  simple_model: "test/simple",
  complex_model: "test/complex",
  visual_model: "test/visual",
  max_concurrency: 4,
  max_review_rounds: 2,
}

function response<T>(data: T) {
  return Promise.resolve({ data })
}

function renderControl(input?: {
  config?: AgentClusterConfig
  rejectSave?: boolean
  identityLocked?: boolean
  currentModel?: { providerID: string; modelID: string }
}) {
  const get = vi.fn(() => response({ agent_cluster: input?.config ?? config }))
  const update = input?.rejectSave
    ? vi.fn(async () => {
        throw new Error("save failed")
      })
    : vi.fn((parameters: unknown) => response(parameters))
  const onModelChange = vi.fn()
  const queryClient = createDesktopQueryClient()
  const invalidate = vi.spyOn(queryClient, "invalidateQueries")
  render(() => (
    <ClusterModelControl
      client={{ global: { config: { get, update } } } as never}
      queryClient={queryClient}
      models={models}
      currentModel={input?.currentModel ?? { providerID: "test", modelID: "planner" }}
      identityLocked={input?.identityLocked}
      onModelChange={onModelChange}
    />
  ))
  return { get, update, invalidate, onModelChange }
}

beforeEach(() => {
  Object.defineProperties(HTMLDialogElement.prototype, {
    close: {
      configurable: true,
      value(this: HTMLDialogElement) {
        this.removeAttribute("open")
        this.dispatchEvent(new Event("close"))
      },
    },
    showModal: {
      configurable: true,
      value(this: HTMLDialogElement) {
        this.setAttribute("open", "")
      },
    },
  })
})

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

describe("cluster model config helpers", () => {
  it("defines only the four supported roles in the required order", () => {
    expect(clusterModelRoles.map((role) => role.label)).toEqual(["主模型", "简单任务", "复杂任务", "视觉与文档"])
    expect(clusterModelRoles.map((role) => role.key)).not.toContain("reviewer_model")
  })

  it("parses, formats, labels, and resolves only unambiguous model values", () => {
    expect(parseClusterModelValue("test/planner")).toEqual({ providerID: "test", modelID: "planner" })
    expect(parseClusterModelValue("planner")).toBeUndefined()
    expect(formatClusterModelValue({ providerID: "test", modelID: "planner" })).toBe("test/planner")
    expect(clusterModelLabel(models[0]!)).toBe("Test · Planner")
    expect(resolveClusterModel("test/planner", models)).toEqual(models[0])
    expect(resolveClusterModel("simple", models)).toEqual(models[1])
    expect(resolveClusterModel("planner", models)).toBeUndefined()
    expect(resolveClusterModel("missing", models)).toBeUndefined()
  })

  it("keeps unrelated agent-cluster settings when the fake backend receives a partial update", async () => {
    const fake = createFakeJyycode()
    await fake.fetch(
      new Request("http://desktop.test/global/config", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ agent_cluster: { planner_model: "test/planner-next" } }),
      }),
    )
    const updated = (await (await fake.fetch("http://desktop.test/global/config")).json()) as {
      agent_cluster: AgentClusterConfig
    }

    expect(updated.agent_cluster).toMatchObject({
      planner_model: "test/planner-next",
      default_on: false,
      max_concurrency: 4,
      max_review_rounds: 2,
    })
  })
})

describe("ClusterModelControl", () => {
  it("shows the current Main model and loads four ordered global selections", async () => {
    const user = userEvent.setup()
    const { get } = renderControl()
    const trigger = screen.getByRole("button", { name: "配置模型：Test · Planner" })
    expect(screen.queryByLabelText("模型")).not.toBeInTheDocument()

    await user.click(trigger)

    const dialog = screen.getByRole("dialog", { name: "配置模型" })
    expect(get).toHaveBeenCalledWith({ throwOnError: true })
    const selects = await within(dialog).findAllByRole("combobox")
    expect(selects.map((select) => select.getAttribute("aria-label"))).toEqual([
      "主模型",
      "主模型 · 思考深度",
      "简单任务",
      "简单任务 · 思考深度",
      "复杂任务",
      "复杂任务 · 思考深度",
      "视觉与文档",
      "视觉与文档 · 思考深度",
    ])
    expect(selects.map((select) => (select as HTMLSelectElement).value)).toEqual([
      "test/planner",
      "",
      "test/simple",
      "",
      "test/complex",
      "",
      "test/visual",
      "",
    ])
    expect(
      within(selects[0]!)
        .getAllByRole("option")
        .map((option) => option.textContent),
    ).toContain("Other · Planner 2")
  })

  it("saves one nested partial update, refreshes global config, announces, closes, and restores focus", async () => {
    const user = userEvent.setup()
    const { update, invalidate, onModelChange } = renderControl()
    const trigger = screen.getByRole("button", { name: "配置模型：Test · Planner" })
    await user.click(trigger)
    const dialog = screen.getByRole("dialog", { name: "配置模型" })
    await user.click(await within(dialog).findByRole("button", { name: "保存" }))

    expect(update).toHaveBeenCalledWith(
      {
        config: {
          agent_cluster: {
            planner_model: "test/planner",
            planner_variant: "",
            simple_model: "test/simple",
            simple_variant: "",
            complex_model: "test/complex",
            complex_variant: "",
            visual_model: "test/visual",
            visual_variant: "",
          },
        },
      },
      { throwOnError: true },
    )
    expect(invalidate).toHaveBeenCalledWith({ queryKey: keys.globalConfig })
    expect(onModelChange).toHaveBeenCalledWith({ providerID: "test", modelID: "planner" })
    await waitFor(() => {
      expect(dialog).not.toHaveAttribute("open")
      expect(trigger).toHaveFocus()
    })
    expect(screen.getByRole("status")).toHaveTextContent("已保存到全局配置")
  })

  it("offers provider variants and saves the selected main thinking depth", async () => {
    const user = userEvent.setup()
    const { update, onModelChange } = renderControl()
    await user.click(screen.getByRole("button", { name: /配置模型/ }))
    const dialog = screen.getByRole("dialog", { name: "配置模型" })
    const depth = await within(dialog).findByRole("combobox", { name: "主模型 · 思考深度" })

    expect(
      within(depth)
        .getAllByRole("option")
        .map((option) => option.textContent),
    ).toEqual(["默认", "low", "high"])
    await user.selectOptions(depth, "high")
    await user.click(within(dialog).getByRole("button", { name: "保存" }))

    expect(update).toHaveBeenCalledWith(
      expect.objectContaining({
        config: expect.objectContaining({
          agent_cluster: expect.objectContaining({ planner_variant: "high" }),
        }),
      }),
      { throwOnError: true },
    )
    expect(onModelChange).toHaveBeenCalledWith({ providerID: "test", modelID: "planner", variant: "high" })
  })

  it("keeps an unavailable configured model visible until the user changes it", async () => {
    const user = userEvent.setup()
    renderControl({ config: { ...config, simple_model: "gone/old" } })
    await user.click(screen.getByRole("button", { name: /配置模型/ }))
    const select = await screen.findByRole("combobox", { name: "简单任务" })

    expect(within(select).getByRole("option", { name: /当前配置不可用/ })).toBeVisible()
    expect(screen.getByRole("button", { name: "保存" })).toBeDisabled()
    await user.selectOptions(select, "test/simple")
    expect(screen.getByRole("button", { name: "保存" })).toBeEnabled()
  })

  it("preserves selections and stays open when saving fails", async () => {
    const user = userEvent.setup()
    renderControl({ rejectSave: true })
    await user.click(screen.getByRole("button", { name: /配置模型/ }))
    const dialog = screen.getByRole("dialog", { name: "配置模型" })
    await user.selectOptions(await within(dialog).findByRole("combobox", { name: "主模型" }), "other/planner")
    await user.click(within(dialog).getByRole("button", { name: "保存" }))

    expect(await within(dialog).findByRole("alert")).toHaveTextContent("save failed")
    expect(dialog).toHaveAttribute("open")
    expect(within(dialog).getByRole("combobox", { name: "主模型" })).toHaveValue("other/planner")
  })

  it("does not write when closed or dismissed with Escape", async () => {
    const user = userEvent.setup()
    const { update } = renderControl()
    const trigger = screen.getByRole("button", { name: /配置模型/ })
    await user.click(trigger)
    await user.click(await screen.findByRole("button", { name: "关闭" }))
    expect(update).not.toHaveBeenCalled()

    await user.click(trigger)
    const dialog = screen.getByRole("dialog", { name: "配置模型" })
    fireEvent(dialog, new Event("cancel", { cancelable: true }))
    expect(update).not.toHaveBeenCalled()
  })

  it("renders a locked child model without opening configuration", async () => {
    const user = userEvent.setup()
    const { get } = renderControl({
      identityLocked: true,
      currentModel: { providerID: "test", modelID: "complex" },
    })
    const control = screen.getByRole("button", { name: "当前模型：Test · Complex" })
    expect(control).toBeDisabled()
    await user.click(control)
    expect(screen.queryByRole("dialog", { name: "配置模型" })).not.toBeInTheDocument()
    expect(get).not.toHaveBeenCalled()
  })
})
