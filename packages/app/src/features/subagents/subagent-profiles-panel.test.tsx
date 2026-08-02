import type { SubagentProfileView } from "@jyycode-ai/sdk/v2/client"
import { cleanup, render, screen } from "@solidjs/testing-library"
import userEvent from "@testing-library/user-event"
import { afterEach, describe, expect, it, vi } from "vitest"
import { SubagentProfilesPanelView } from "./subagent-profiles-panel"

const profile: SubagentProfileView = {
  id: "general",
  name: "General",
  description: "General-purpose execution.",
  prompt: "",
  avatar: "bot",
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

afterEach(cleanup)

describe("SubagentProfilesPanelView", () => {
  it("edits a profile and creates a role-scoped skill", async () => {
    const user = userEvent.setup()
    const onSave = vi.fn().mockResolvedValue(undefined)
    const onCreateSkill = vi.fn().mockResolvedValue(undefined)
    render(() => (
      <SubagentProfilesPanelView
        profiles={[profile]}
        onSave={onSave}
        onCreateSkill={onCreateSkill}
        onRefresh={vi.fn()}
      />
    ))

    expect(screen.getByText(/1 \/ 1/)).toBeVisible()
    expect(screen.getByText("manual")).toBeVisible()

    await user.click(screen.getByRole("button", { name: "新建专属技能" }))
    await user.type(screen.getByLabelText("技能名称"), "review-notes")
    await user.type(screen.getByLabelText("SKILL.md"), "# Review notes")
    await user.click(screen.getByRole("button", { name: "创建技能" }))
    expect(onCreateSkill).toHaveBeenCalledWith("general", { name: "review-notes", content: "# Review notes" })

    await user.click(screen.getByRole("button", { name: "新建子 Agent" }))
    await user.type(screen.getByLabelText("角色 ID"), "reviewer")
    await user.type(screen.getByLabelText("角色名称"), "Reviewer")
    await user.type(screen.getByLabelText("角色描述"), "Checks delegated work.")
    await user.type(screen.getByLabelText("启动提示词"), "Use the checklist.")
    await user.type(screen.getByLabelText("模型"), "openai/gpt-5")
    await user.selectOptions(screen.getByLabelText("思考深度"), "low")
    await user.click(screen.getByRole("button", { name: "选择头像 code" }))
    await user.click(screen.getByLabelText("启用角色"))
    await user.click(screen.getByRole("button", { name: "保存角色" }))

    expect(onSave).toHaveBeenCalledWith([
      expect.objectContaining({ id: "general", name: "General" }),
      expect.objectContaining({
        id: "reviewer",
        name: "Reviewer",
        description: "Checks delegated work.",
        prompt: "Use the checklist.",
        avatar: "code",
        model: "openai/gpt-5",
        variant: "low",
        enabled: false,
      }),
    ])

  })
})
