import { expect, it } from "bun:test"

import {
  builtinProfiles,
  defaultGeneralProfile,
  defaultProfiles,
  enabledProfiles,
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
  tools: ["read", "edit", "plugin_custom"],
  enabled: true,
}

it("defaults to the built-in roles that ship with jyycode", () => {
  const resolved = resolveProfiles()
  expect(resolved).toEqual(defaultProfiles())
  expect(resolved.length).toBe(builtinProfiles.length)
  expect(profileByID(resolved, "general")).toBeDefined()
  expect(profileByID(resolved, "researcher")).toBeDefined()
  expect(profileByID(resolved, "coder_backend")).toBeDefined()
  expect(profileByID(resolved, "coder_frontend")).toBeDefined()
  expect(profileByID(resolved, "Planner")).toBeDefined()
  expect(profileByID(resolved, "office_master")).toBeDefined()
  expect(profileByID(resolved, "charter")).toBeDefined()
  expect(profileAgentName("general")).toBe("subagent:general")
})

it("returns fresh copies of the built-in defaults", () => {
  const first = resolveProfiles()
  const second = resolveProfiles()
  expect(first).not.toBe(second)
  expect(first[0]).not.toBe(second[0])
  expect(first.find((profile) => profile.id === "coder_backend")?.tools).not.toBe(
    second.find((profile) => profile.id === "coder_backend")?.tools,
  )
})

it("accepts custom profiles and resolves them by stable id", () => {
  const profiles = resolveProfiles([defaultGeneralProfile, customProfile])
  expect(profiles).toEqual([defaultGeneralProfile, customProfile])
  expect(profileByID(profiles, "role_review")).toEqual(customProfile)
  expect(enabledProfiles([{ ...customProfile, enabled: false }, ...profiles])).toEqual(profiles)
})

it("rejects duplicate ids, duplicate display names, invalid avatars, and forbidden tools", () => {
  expect(() => resolveProfiles([defaultGeneralProfile, { ...customProfile, id: "general" }])).toThrow()
  expect(() => resolveProfiles([defaultGeneralProfile, { ...customProfile, name: "general" }])).toThrow()
  expect(() => resolveProfiles([defaultGeneralProfile, { ...customProfile, avatar: "rocket" as never }])).toThrow()
  expect(() => resolveProfiles([defaultGeneralProfile, { ...customProfile, tools: ["memory"] as never }])).toThrow()
  expect(() => resolveProfiles([defaultGeneralProfile, { ...customProfile, tools: ["read", "read"] }])).toThrow()
  expect(() => resolveProfiles([defaultGeneralProfile, { ...customProfile, tools: [" read"] }])).toThrow()
})

it("allows deleting every role, including general", () => {
  expect(resolveProfiles([customProfile])).toEqual([customProfile])
  expect(resolveProfiles([])).toEqual([])
})

it("accepts terminal tools without extra configuration", () => {
  const profiles = resolveProfiles([defaultGeneralProfile, { ...customProfile, tools: ["bash", "process"] }])
  expect(profiles[1]?.tools).toEqual(["bash", "process"])
})

it("preserves omitted and explicitly empty tool allowlists", () => {
  expect(resolveProfiles([defaultGeneralProfile, customProfile])[1]?.tools).toEqual(["read", "edit", "plugin_custom"])
  expect(resolveProfiles([defaultGeneralProfile, { ...customProfile, tools: [] }])[1]?.tools).toEqual([])
  expect(resolveProfiles([defaultGeneralProfile])[0]?.tools).toBeUndefined()
})
