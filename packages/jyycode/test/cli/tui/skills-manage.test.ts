import { describe, expect, test } from "bun:test"
import {
  isBuiltinSkill,
  isRoleSkill,
  skillSourceType,
  skillOriginLabel,
  parseSkillFrontmatter,
  type SkillListItem,
} from "../../../src/cli/cmd/tui/feature-plugins/system/skills-manage"

const skill = (overrides: Partial<SkillListItem>): SkillListItem => ({
  id: "s1",
  name: "x",
  location: "/tmp/x/SKILL.md",
  content: "",
  origin: "managed",
  editable: true,
  deletable: true,
  revision: "r1",
  ...overrides,
})

describe("skills-manage logic", () => {
  test("built-in 与 role skill 判定", () => {
    expect(isBuiltinSkill(skill({ origin: "built_in" }))).toBe(true)
    expect(isBuiltinSkill(skill({ origin: "managed" }))).toBe(false)
    expect(isRoleSkill(skill({ origin: "role" }))).toBe(true)
    expect(isRoleSkill(skill({ origin: "managed" }))).toBe(false)
  })

  test("skillSourceType 归一化来源标签", () => {
    expect(skillSourceType(undefined)).toBe("managed")
    expect(skillSourceType("https://example.com/x/SKILL.md")).toBe("url")
    expect(skillSourceType("/home/user/skills/x")).toBe("path")
  })

  test("origin 标签映射", () => {
    expect(skillOriginLabel("built_in")).toBe("内置")
    expect(skillOriginLabel("managed")).toBe("托管")
    expect(skillOriginLabel("path")).toBe("路径")
    expect(skillOriginLabel("url")).toBe("远程")
    expect(skillOriginLabel("role")).toBe("角色")
  })

  test("parseSkillFrontmatter 分离 frontmatter 与正文", () => {
    const content = "---\nname: x\ndescription: d\n---\n\n# 正文\n内容"
    const parsed = parseSkillFrontmatter(content)
    expect(parsed.frontmatter).toContain("name: x")
    expect(parsed.body).toContain("# 正文")
    expect(parseSkillFrontmatter("无 frontmatter").frontmatter).toBe("")
    expect(parseSkillFrontmatter("无 frontmatter").body).toBe("无 frontmatter")
  })
})
