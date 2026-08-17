import { describe, expect, test } from "bun:test"
import {
  profileForm,
  validateProfile,
  avatarOptions,
  type ProfileForm,
} from "../../../src/cli/cmd/tui/feature-plugins/system/subagent-profiles"
import type { SubagentProfile } from "@jyycode-ai/sdk/v2"

const profile: SubagentProfile = {
  id: "p1",
  name: "reviewer",
  description: "reviews diffs",
  prompt: "You are a reviewer.",
  avatar: "bot",
  enabled: false,
}

describe("subagent profiles logic", () => {
  test("profileForm 映射远端字段", () => {
    const form = profileForm(profile)
    expect(form.enabled).toBe(false)
    expect(form.description).toBe("reviews diffs")
    expect(form.name).toBe("reviewer")
    expect(form.avatar).toBe("bot")
  })

  test("validateProfile 要求 name 与 prompt 非空", () => {
    expect(validateProfile({ name: "", description: "", prompt: "x", avatar: "bot", enabled: true }).name).toBeTruthy()
    expect(
      validateProfile({ name: "x", description: "", prompt: "", avatar: "bot", enabled: true }).prompt,
    ).toBeTruthy()
    const valid: ProfileForm = { name: "x", description: "", prompt: "p", avatar: "bot", enabled: true }
    expect(validateProfile(valid)).toEqual({})
  })

  test("avatar 目录包含默认头像", () => {
    const options = avatarOptions()
    expect(options.length).toBeGreaterThan(0)
    expect(options).toContain("bot")
    expect(options).toContain("sparkles")
  })
})
