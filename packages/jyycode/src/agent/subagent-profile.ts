import { Schema } from "effect"
import { PositiveInt } from "@jyycode-ai/core/schema"
import { isSubagentForbiddenToolID, isSubagentFixedToolID, isSubagentSelectableToolID } from "./subagent-tool-policy"

const NON_EMPTY_TEXT = Schema.String.check(Schema.isPattern(/\S/))
const TOOL_ID = Schema.String.check(Schema.isPattern(/\S/))
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
  steps: Schema.optional(PositiveInt),
  timeout_ms: Schema.optional(PositiveInt),
  no_progress_steps: Schema.optional(PositiveInt),
  /** Omitted means all currently available non-system tools; [] means no user-selectable tools. */
  tools: Schema.optional(Schema.mutable(Schema.Array(TOOL_ID))),
  enabled: Schema.Boolean,
}).annotate({ identifier: "SubagentProfile" })
export type SubagentProfile = Schema.Schema.Type<typeof Profile>

export type ProfileSnapshot = Pick<SubagentProfile, "id" | "name" | "description" | "avatar">
export type LaunchSnapshot = ProfileSnapshot &
  Pick<
    SubagentProfile,
    "prompt" | "model" | "variant" | "tools" | "steps" | "timeout_ms" | "no_progress_steps"
  >

export const defaultGeneralProfile: SubagentProfile = {
  id: "general",
  name: "General",
  description: "General-purpose agent for delegated execution.",
  prompt: "",
  avatar: "bot",
  enabled: true,
}

/**
 * Built-in subagent roles that ship with jyycode. A fresh install starts with
 * these profiles; users may freely edit, disable, or delete them afterwards,
 * and any saved change is persisted to the global config so the defaults only
 * apply while no subagent configuration exists.
 */
export const builtinProfiles: readonly SubagentProfile[] = [
  { ...defaultGeneralProfile },
  {
    id: "coder_backend",
    name: "后端工程师",
    description: "专业的后端代码工程师",
    prompt: "Focus on backend contracts, data boundaries, failure handling, and maintainable implementation. Verify affected behavior and state any compatibility risk or unresolved dependency.",
    avatar: "code",
    model: "deepseek/deepseek-v4-flash",
    variant: "max",
    tools: ["edit", "glob", "grep", "read", "write", "bash", "process"],
    enabled: false,
  },
  {
    id: "researcher",
    name: "调查员",
    description: "专业的信息调查员，能广泛搜集、整理各种网络信息",
    prompt: "Find reliable primary evidence, distinguish facts from inference, and deliver concise findings with sources, uncertainty, and decision-relevant tradeoffs.",
    avatar: "search",
    model: "deepseek/deepseek-v4-flash",
    variant: "low",
    enabled: true,
  },
  {
    id: "coder_frontend",
    name: "前端工程师",
    description: "专业的前端代码工程师",
    prompt: "Focus on accessible, responsive UI behavior, existing design conventions, and user-visible edge cases. Verify the affected interaction and report any visual or compatibility tradeoff.",
    avatar: "code",
    model: "kimi-for-coding/k3",
    variant: "low",
    tools: ["edit", "glob", "grep", "read", "write", "bash", "process"],
    enabled: false,
  },
  {
    id: "Planner",
    name: "方案设计师",
    description: "专业的方案设计师",
    prompt: "Compare viable approaches against the stated goal and constraints. Recommend one implementable path with acceptance criteria, dependencies, risks, and the smallest useful verification set.",
    avatar: "pen",
    model: "deepseek/deepseek-v4-flash",
    variant: "high",
    tools: ["edit", "glob", "grep", "read", "write", "bash", "process"],
    enabled: true,
  },
  {
    id: "office_master",
    name: "office高手",
    description: "精通word/ppt/excel/pdf等office软件的高手",
    prompt: "Produce polished office artifacts that preserve requested content, structure, and visual hierarchy. Validate the rendered output and flag any source-data or layout limitation.",
    avatar: "chart",
    model: "kimi-for-coding/k3",
    variant: "low",
    tools: ["edit", "glob", "grep", "read", "webfetch", "websearch", "write", "bash", "process"],
    enabled: true,
  },
  {
    id: "charter",
    name: "图表师",
    description: "精通各类图表绘制的大师",
    prompt: "Choose a chart that makes the requested comparison clear. Preserve data fidelity, readable labels, and correct Chinese text; validate the final visual before delivery.",
    avatar: "image",
    model: "kimi-for-coding/k3",
    tools: ["bash", "edit", "glob", "grep", "process", "read", "webfetch", "websearch", "write"],
    enabled: true,
  },
]

export function defaultProfiles(): SubagentProfile[] {
  return builtinProfiles.map((profile) => ({
    ...profile,
    ...(profile.tools !== undefined ? { tools: [...profile.tools] } : {}),
  }))
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
  if (profile.tools !== undefined) {
    const ids = new Set<string>()
    for (const toolID of profile.tools) {
      if (toolID !== toolID.trim()) {
        throw new Error(`subagents.profiles[${index}].tools must not contain surrounding whitespace`)
      }
      if (!isSubagentSelectableToolID(toolID) || isSubagentForbiddenToolID(toolID) || isSubagentFixedToolID(toolID)) {
        throw new Error(`subagents.profiles[${index}].tools cannot configure system tool: ${toolID}`)
      }
      if (ids.has(toolID)) throw new Error(`duplicate subagent tool ID: ${toolID}`)
      ids.add(toolID)
    }
  }
}

/** Decode and validate the project-level profile list. */
export function resolveProfiles(input?: readonly unknown[]): SubagentProfile[] {
  if (input === undefined) return defaultProfiles()
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
    ...(profile.tools !== undefined ? { tools: [...profile.tools] } : {}),
    ...(profile.steps !== undefined ? { steps: profile.steps } : {}),
    ...(profile.timeout_ms !== undefined ? { timeout_ms: profile.timeout_ms } : {}),
    ...(profile.no_progress_steps !== undefined ? { no_progress_steps: profile.no_progress_steps } : {}),
  }
}

/** Stable internal Agent name; the profile id remains the dispatch-facing key. */
export function profileAgentName(id: string) {
  return `subagent:${id}`
}

export * as SubagentProfile from "./subagent-profile"
