import { Context, Effect, Layer } from "effect"

import { InstanceState } from "@/effect/instance-state"

import PROMPT from "./prompt/default.txt"
import type { Provider } from "@/provider/provider"
import type { Agent } from "@/agent/agent"
import { Permission } from "@/permission"
import { Skill } from "@/skill"
import { Memory } from "@/memory/memory"

// Single unified base prompt for every model — no per-vendor variants.
export function provider() {
  return [PROMPT]
}

const MEMORY_RULES = [
  `Persistent memory JSON files live in ${Memory.DIRECTORY}: MEMORY.json (one shared task-state entry per project), USER.json (stable user facts), and EXPERIENCE.json (success/failure/lesson rules shared across all projects).`,
  "Task memory is updated automatically by the runtime twice per turn — never call the memory tool for these routine updates; use it only when the user explicitly asks to manage memories.",
  "To inspect what is remembered, call the memory tool with action=read (target=memory or target=user); for past lessons call context_read with action=experience. Do not read the JSON files directly with file tools.",
  "Task state uses the format 当前任务：<goal>；进展：<progress>；[经验：<lesson>] with limits goal ≤120, progress ≤160, 经验 ≤160 Unicode chars. Write 经验 only when this turn produced a durable success or failure lesson; never write 下一步.",
  "Before retrying a failed step or starting a similar task, use context_read with action=experience to check past lessons.",
  "Never store secrets or credentials, and never create .md files in the memory directory. Snapshot budgets: task ≤400 chars, user ≤1200 chars, at most 3 matching experiences ≤1200 chars. Subagents are read-only.",
].join("\n")

export interface Interface {
  readonly environment: (model: Provider.Model, options?: { includeMemory?: boolean }) => Effect.Effect<string[]>
  readonly skills: (agent: Agent.Info, scope?: Skill.SkillAccessScope) => Effect.Effect<string | undefined>
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

      skills: Effect.fn("SystemPrompt.skills")(function* (
        agent: Agent.Info,
        scope: Skill.SkillAccessScope = Skill.rootScope,
      ) {
        if (Permission.disabled(["skill"], agent.permission).has("skill")) return

        const list = yield* skill.available(scope, agent)

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
