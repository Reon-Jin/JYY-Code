import { Schema } from "effect"

const NON_EMPTY_TEXT = Schema.String.check(Schema.isPattern(/\S/))
const PROFILE_ID = Schema.String.check(Schema.isPattern(/^[A-Za-z0-9][A-Za-z0-9_-]*$/))

export const Avatar = Schema.Literals([
  "bot",
  "search",
  "code",
  "bug",
  "chart",
  "file",
  "image",
  "folder",
  "pen",
  "sparkles",
])
export type SubagentAvatar = Schema.Schema.Type<typeof Avatar>

export const Profile = Schema.Struct({
  id: PROFILE_ID,
  name: NON_EMPTY_TEXT,
  description: NON_EMPTY_TEXT,
  prompt: Schema.String,
  avatar: Avatar,
  model: Schema.optional(NON_EMPTY_TEXT),
  variant: Schema.optional(NON_EMPTY_TEXT),
  enabled: Schema.Boolean,
}).annotate({ identifier: "SubagentProfile" })
export type SubagentProfile = Schema.Schema.Type<typeof Profile>

export type ProfileSnapshot = Pick<SubagentProfile, "id" | "name" | "description" | "avatar">
export type LaunchSnapshot = ProfileSnapshot & Pick<SubagentProfile, "prompt" | "model" | "variant">

export const defaultGeneralProfile: SubagentProfile = {
  id: "general",
  name: "General",
  description: "General-purpose agent for delegated execution.",
  prompt: "",
  avatar: "bot",
  enabled: true,
}

/** Role names from the removed built-in subagent catalog. */
export const LEGACY_SUBAGENT_AGENT_KEYS = [
  "general",
  "explore",
  "scout",
  "researcher",
  "analyst",
  "writer",
  "chart",
  "office",
  "coder",
  "tester",
  "picture_searcher",
  "picture-searcher",
  "visual",
  "pdf",
] as const

const LEGACY_KEYS = new Set<string>(LEGACY_SUBAGENT_AGENT_KEYS)

export function normalizeLegacyAgentConfig(agent: Record<string, unknown> | undefined) {
  if (!agent) return agent
  return Object.fromEntries(Object.entries(agent).filter(([key]) => !LEGACY_KEYS.has(key)))
}

function validateProfile(profile: SubagentProfile, index: number) {
  if (!profile.id.trim() || !profile.name.trim() || !profile.description.trim()) {
    throw new Error(`subagents.profiles[${index}] has an empty required field`)
  }
  if (profile.id !== profile.id.trim()) {
    throw new Error(`subagents.profiles[${index}].id must not have surrounding whitespace`)
  }
  if (profile.name !== profile.name.trim()) {
    throw new Error(`subagents.profiles[${index}].name must not have surrounding whitespace`)
  }
  if (profile.description !== profile.description.trim()) {
    throw new Error(`subagents.profiles[${index}].description must not have surrounding whitespace`)
  }
}

/** Decode and validate the project-level profile list. */
export function resolveProfiles(input?: readonly unknown[]): SubagentProfile[] {
  if (input === undefined) return [{ ...defaultGeneralProfile }]
  if (!Array.isArray(input)) throw new Error("subagents.profiles must be an array")

  const profiles = input.map((value, index) => {
    const profile = Schema.decodeUnknownSync(Profile)(value)
    validateProfile(profile, index)
    return { ...profile }
  })

  const ids = new Set<string>()
  const names = new Set<string>()
  for (const profile of profiles) {
    if (ids.has(profile.id)) throw new Error(`duplicate subagent profile id: ${profile.id}`)
    ids.add(profile.id)

    const name = profile.name.toLocaleLowerCase()
    if (names.has(name)) throw new Error(`duplicate subagent profile name: ${profile.name}`)
    names.add(name)
  }

  if (!profiles.some((profile) => profile.id === defaultGeneralProfile.id)) {
    throw new Error('subagents.profiles must include the "general" profile')
  }

  return profiles
}

export function enabledProfiles(profiles: readonly SubagentProfile[]) {
  return profiles.filter((profile) => profile.enabled)
}

export function profileByID(profiles: readonly SubagentProfile[], id: string) {
  return profiles.find((profile) => profile.id === id)
}

export function profileSnapshot(profile: SubagentProfile): ProfileSnapshot {
  return {
    id: profile.id,
    name: profile.name,
    description: profile.description,
    avatar: profile.avatar,
  }
}

export function launchSnapshot(profile: SubagentProfile): LaunchSnapshot {
  return {
    ...profileSnapshot(profile),
    prompt: profile.prompt,
    ...(profile.model ? { model: profile.model } : {}),
    ...(profile.variant ? { variant: profile.variant } : {}),
  }
}

/** Stable internal Agent name; the profile id remains the dispatch-facing key. */
export function profileAgentName(id: string) {
  return `subagent:${id}`
}

export * as SubagentProfile from "./subagent-profile"
