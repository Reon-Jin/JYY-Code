import { expect, it } from "bun:test"

import {
  defaultGeneralProfile,
  enabledProfiles,
  normalizeLegacyAgentConfig,
  profileAgentName,
  profileByID,
  resolveProfiles,
  type SubagentProfile,
} from "../../src/agent/subagent-profile"

const customProfile: SubagentProfile = {
  id: "role_review",
  name: "Review",
  description: "Reviews implementation changes.",
  prompt: "Review the delegated task carefully.",
  avatar: "bug",
  enabled: true,
}

it("defaults to the enabled General profile", () => {
  expect(resolveProfiles()).toEqual([defaultGeneralProfile])
  expect(enabledProfiles(resolveProfiles())).toEqual([defaultGeneralProfile])
  expect(profileAgentName("general")).toBe("subagent:general")
})

it("accepts custom profiles and resolves them by stable id", () => {
  const profiles = resolveProfiles([defaultGeneralProfile, customProfile])
  expect(profiles).toEqual([defaultGeneralProfile, customProfile])
  expect(profileByID(profiles, "role_review")).toEqual(customProfile)
  expect(enabledProfiles([{ ...customProfile, enabled: false }, ...profiles])).toEqual(profiles)
})

it("rejects duplicate ids, duplicate display names, invalid avatars, and missing General", () => {
  expect(() => resolveProfiles([defaultGeneralProfile, { ...customProfile, id: "general" }])).toThrow()
  expect(() => resolveProfiles([defaultGeneralProfile, { ...customProfile, name: "general" }])).toThrow()
  expect(() => resolveProfiles([defaultGeneralProfile, { ...customProfile, avatar: "rocket" as never }])).toThrow()
  expect(() => resolveProfiles([customProfile])).toThrow()
})

it("removes legacy role configuration without removing unrelated user agents", () => {
  const cleaned = normalizeLegacyAgentConfig({
    general: { description: "old" },
    explore: { description: "old" },
    researcher: { description: "old" },
    coder: { description: "old" },
    my_custom_agent: { description: "keep" },
  })

  expect(cleaned).toEqual({ my_custom_agent: { description: "keep" } })
})
