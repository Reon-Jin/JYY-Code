import type { SubagentProfileView } from "@jyycode-ai/sdk/v2/client"
import { cleanup, render, screen, within } from "@solidjs/testing-library"
import userEvent from "@testing-library/user-event"
import { afterEach, describe, expect, it, vi } from "vitest"
import type { CatalogModel } from "../composer/model-catalog"
import { SubagentProfilesPanelView } from "./subagent-profiles-panel"

const profile: SubagentProfileView = {
  id: "general",
  name: "General",
  description: "General-purpose execution.",
  prompt: "",
  avatar: "bot",
  tools: ["read"],
  model: "test-provider/test-model",
  enabled: true,
  skills: [
    {
      id: "role:general:manual",
      name: "manual",
      description: "Manual skill",
      location: "C:\\Users\\demo\\.jyycode\\role\\general\\skills\\manual\\SKILL.md",
      content: "# Manual",
      origin: "role",
      editable: true,
      deletable: true,
      revision: "1",
    },
  ],
}

const models: CatalogModel[] = [
  {
    providerID: "test-provider",
    providerName: "Test Provider",
    modelID: "test-model",
    modelName: "Test Model",
    contextWindow: 128_000,
    variants: [],
  },
  {
    providerID: "openai",
    providerName: "OpenAI",
    modelID: "gpt-5",
    modelName: "GPT-5",
    contextWindow: 400_000,
    variants: ["low", "high"],
  },
]

const disabledProfile: SubagentProfileView = {
  id: "reviewer",
  name: "Reviewer",
  description: "Checks delegated work.",
  prompt: "Use the checklist.",
  avatar: "code",
  enabled: false,
  skills: [],
}

afterEach(cleanup)

describe("SubagentProfilesPanelView", () => {
  it("lists profiles with switches and opens the editor from each row", async () => {
    const user = userEvent.setup()
    const onSave = vi.fn().mockResolvedValue(undefined)
    const onCreateSkill = vi.fn().mockResolvedValue(undefined)
    const onRefresh = vi.fn().mockResolvedValue(undefined)
    render(() => (
      <SubagentProfilesPanelView
        profiles={[profile, disabledProfile]}
        toolIDs={["read", "bash", "write", "mcp_docs"]}
        models={models}
        onSave={onSave}
        onCreateSkill={onCreateSkill}
        onRefresh={onRefresh}
      />
    ))

    expect(screen.getByText(/1 \/ 2/)).toBeVisible()
    expect(screen.getByRole("switch", { name: "启用角色 General" })).toHaveAttribute("aria-checked", "true")
    expect(screen.getByRole("switch", { name: "启用角色 Reviewer" })).toHaveAttribute("aria-checked", "false")
    expect(screen.getByRole("button", { name: "编辑角色 General" })).toBeVisible()
    expect(screen.getByRole("button", { name: "编辑角色 Reviewer" })).toBeVisible()

    await user.click(screen.getByRole("switch", { name: "启用角色 Reviewer" }))
    expect(onSave).toHaveBeenLastCalledWith([
      expect.objectContaining({ id: "general", enabled: true }),
      expect.objectContaining({ id: "reviewer", enabled: true }),
    ])

    await user.click(screen.getByRole("button", { name: "编辑角色 General" }))
    const editDialog = screen.getByRole("dialog")
    const refreshButton = editDialog.querySelector<HTMLButtonElement>(".subagent-profile-skills__refresh")
    expect(refreshButton).not.toBeNull()
    await user.click(refreshButton!)
    expect(onRefresh).toHaveBeenCalledTimes(1)
    expect(within(editDialog).getByRole("checkbox", { name: "read" })).toBeChecked()
    expect(within(editDialog).getByRole("checkbox", { name: "mcp_docs" })).not.toBeChecked()
    expect(within(editDialog).getByRole("checkbox", { name: "bash" })).not.toBeChecked()
    expect(within(editDialog).getByDisplayValue("general")).toBeVisible()
    expect(within(editDialog).getByText("manual")).toBeVisible()
    expect(within(editDialog).getByText("用于内部派发的唯一标识，创建后不可修改。")).toBeVisible()
    expect(within(editDialog).getByText("显示给用户和主 Agent 的角色名称。")).toBeVisible()
    expect(within(editDialog).getByRole("combobox", { name: "模型" })).toHaveValue("test-provider/test-model")
    expect(within(editDialog).queryByRole("textbox", { name: "模型" })).not.toBeInTheDocument()

    await user.click(within(editDialog).getByRole("button", { name: "新建专属技能" }))
    await user.type(within(editDialog).getByLabelText("技能名称"), "review-notes")
    await user.type(within(editDialog).getByLabelText("SKILL.md"), "# Review notes")
    await user.click(within(editDialog).getByRole("button", { name: "创建技能" }))
    expect(onCreateSkill).toHaveBeenCalledWith("general", { name: "review-notes", content: "# Review notes" })

    await user.click(screen.getByRole("button", { name: "关闭" }))
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument()

    await user.click(screen.getByRole("button", { name: "新建子 Agent" }))
    const newDialog = screen.getByRole("dialog")
    await user.click(within(newDialog).getByRole("checkbox", { name: "write" }))
    await user.type(screen.getByLabelText("角色 ID"), "architect")
    await user.type(screen.getByLabelText("角色名称"), "Reviewer")
    await user.type(screen.getByLabelText("角色描述"), "Checks delegated work.")
    await user.type(screen.getByLabelText("启动提示词"), "Use the checklist.")
    expect(within(newDialog).queryByRole("textbox", { name: "模型" })).not.toBeInTheDocument()
    await user.selectOptions(screen.getByLabelText("模型"), "openai/gpt-5")
    await user.selectOptions(screen.getByLabelText("思考深度"), "low")
    await user.click(screen.getByRole("button", { name: "选择头像 code" }))
    await user.click(screen.getByLabelText("启用角色"))
    expect(within(newDialog).getByDisplayValue("architect")).toBeVisible()
    expect(within(newDialog).getByRole("combobox", { name: "模型" })).toHaveValue("openai/gpt-5")
    await user.click(screen.getByRole("button", { name: "保存角色" }))

    expect(onSave).toHaveBeenLastCalledWith([
      expect.objectContaining({ id: "general", name: "General" }),
      expect.objectContaining({ id: "reviewer", name: "Reviewer", enabled: false }),
      expect.objectContaining({
        id: "architect",
        name: "Reviewer",
        description: "Checks delegated work.",
        prompt: "Use the checklist.",
        avatar: "code",
        model: "openai/gpt-5",
        variant: "low",
        tools: ["bash", "mcp_docs", "read"],
        enabled: false,
      }),
    ])
  })
})
