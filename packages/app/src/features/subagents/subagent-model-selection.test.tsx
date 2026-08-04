import type { SubagentProfileView } from "@jyycode-ai/sdk/v2/client"
import { cleanup, render, screen, within } from "@solidjs/testing-library"
import userEvent from "@testing-library/user-event"
import { afterEach, describe, expect, it, vi } from "vitest"
import { createSignal } from "solid-js"
import type { CatalogModel } from "../composer/model-catalog"
import { SubagentProfilesPanelView } from "./subagent-profiles-panel"

const models: CatalogModel[] = [
  {
    providerID: "deepseek",
    providerName: "DeepSeek",
    modelID: "deepseek-v4-pro",
    modelName: "DeepSeek V4 Pro",
    contextWindow: 128_000,
    variants: [],
  },
  {
    providerID: "kimi-for-coding",
    providerName: "Kimi",
    modelID: "k3",
    modelName: "K3",
    contextWindow: 256_000,
    variants: ["low", "high"],
  },
]

const baseProfile: SubagentProfileView = {
  id: "general",
  name: "General",
  description: "General-purpose execution.",
  prompt: "",
  avatar: "bot",
  enabled: true,
  skills: [],
}

afterEach(cleanup)

describe("subagent model selection", () => {
  it("keeps an explicit model that matches the main agent model", async () => {
    const user = userEvent.setup()
    const onDelete = vi.fn().mockResolvedValue(undefined)
    const onCreateSkill = vi.fn().mockResolvedValue(undefined)
    const onRefresh = vi.fn().mockResolvedValue(undefined)
    const [profiles, setProfiles] = createSignal<SubagentProfileView[]>([baseProfile])
    const onSave = vi.fn().mockImplementation(async (next: readonly { id: string }[]) => {
      setProfiles(next.map((profile) => ({ ...(profile as object), skills: [] }) as unknown as SubagentProfileView))
    })

    render(() => (
      <SubagentProfilesPanelView
        profiles={profiles()}
        toolIDs={["read"]}
        models={models}
        onSave={onSave}
        onDelete={onDelete}
        onCreateSkill={onCreateSkill}
        onRefresh={onRefresh}
      />
    ))

    // Pick the same model the main agent uses, explicitly (not 跟随主 Agent).
    await user.click(screen.getByRole("button", { name: "编辑角色 General" }))
    let editor = screen.getByRole("dialog")
    await user.selectOptions(within(editor).getByRole("combobox", { name: "模型" }), "deepseek/deepseek-v4-pro")
    expect(within(editor).getByRole("combobox", { name: "模型" })).toHaveValue("deepseek/deepseek-v4-pro")
    await user.click(within(editor).getByRole("button", { name: "保存角色" }))

    expect(onSave).toHaveBeenCalledTimes(1)
    const saved = onSave.mock.calls[0]?.[0] as Array<{ id: string; model?: string }>
    expect(saved.find((profile) => profile.id === "general")?.model).toBe("deepseek/deepseek-v4-pro")

    // Reopen the editor with the saved profile: it must not show 跟随主 Agent.
    await user.click(screen.getByRole("button", { name: "编辑角色 General" }))
    editor = screen.getByRole("dialog")
    expect(within(editor).getByRole("combobox", { name: "模型" })).toHaveValue("deepseek/deepseek-v4-pro")
  })
})
