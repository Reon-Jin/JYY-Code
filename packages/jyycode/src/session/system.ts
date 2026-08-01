import { Context, Effect, Layer } from "effect"

import { InstanceState } from "@/effect/instance-state"

import PROMPT from "./prompt/default.txt"
import type { Provider } from "@/provider/provider"
import type { Agent } from "@/agent/agent"
import { Permission } from "@/permission"
import { Skill } from "@/skill"

// Single unified base prompt for every model — no per-vendor variants.
export function provider() {
  return [PROMPT]
}

const MEMORY_RULES = [
  "Persistent memory lives in the memory directory: MEMORY.json holds one cumulative task entry per session (20,000-char limit) and USER.json holds stable user facts keyed by 2-4 character keywords (2,000-char limit).",
  "Task memory is updated automatically by the runtime twice per turn — never call the memory tool for these routine updates; use it only when the user explicitly asks to manage memories.",
  "Entries are semantic compressions, never sliced text or ellipses: 用户要求 ≤100, 我用了 ≤180, 最终学会了 ≤100 Unicode chars (prefixes excluded).",
  "Never store secrets or credentials, and never create .md files in the memory directory. A top-10 snapshot of each store is injected at session start; subagents are read-only.",
].join("\n")

export interface Interface {
  readonly environment: (model: Provider.Model, options?: { includeMemory?: boolean }) => Effect.Effect<string[]>
  readonly skills: (agent: Agent.Info) => Effect.Effect<string | undefined>
}

export class Service extends Context.Service<Service, Interface>()("@jyycode/SystemPrompt") {}

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const skill = yield* Skill.Service

    return Service.of({
      environment: Effect.fn("SystemPrompt.environment")(function* (
        model: Provider.Model,
        options?: { includeMemory?: boolean },
      ) {
        const ctx = yield* InstanceState.context
        return [
          [
            `You are JYYCode, a personal AI assistant powered by the model ${model.providerID}/${model.api.id}.`,
            `<env>`,
            `Working directory: ${ctx.directory}`,
            `Workspace root: ${ctx.worktree}`,
            `Git repo: ${ctx.project.vcs === "git" ? "yes" : "no"}`,
            `Platform: ${process.platform}`,
            `Date: ${new Date().toDateString()}`,
            `</env>`,
            ...(options?.includeMemory === false ? [] : ["", MEMORY_RULES]),
          ].join("\n"),
        ]
      }),

      skills: Effect.fn("SystemPrompt.skills")(function* (agent: Agent.Info) {
        if (Permission.disabled(["skill"], agent.permission).has("skill")) return

        const list = yield* skill.available(agent)

        return [
          "Skills provide specialized instructions and workflows for specific tasks.",
          "Use the skill tool to load a skill when a task matches its description.",
          // the agents seem to ingest the information about skills a bit better if we present a more verbose
          // version of them here and a less verbose version in tool description, rather than vice versa.
          Skill.fmt(list, { verbose: true }),
        ].join("\n")
      }),
    })
  }),
)

export const defaultLayer = layer.pipe(Layer.provide(Skill.defaultLayer))

export * as SystemPrompt from "./system"
