import { Context, Effect, Layer } from "effect"

import { InstanceState } from "@/effect/instance-state"

import PROMPT from "./prompt/default.txt"
import type { Provider } from "@/provider/provider"
import type { Agent } from "@/agent/agent"
import { Permission } from "@/permission"
import { Skill } from "@/skill"

// Single unified base prompt for every interactive model; no per-vendor variants.
export function provider() {
  return [PROMPT]
}

export const RUNTIME_CONTRACT = [
  "## Context and memory",
  "- Task state is updated by the runtime. Do not manage persistent memory unless the user explicitly asks.",
  "- For exact details outside the current context, use context_read; before retrying a similar failure, use context_read(action=experience).",
  "- Only the root session may change persistent memory. Other sessions' memory is read-only context. Never read memory files directly.",
].join("\n")

export interface Interface {
  readonly environment: (model: Provider.Model, input?: { child?: boolean }) => Effect.Effect<string[]>
  readonly skills: (agent: Agent.Info, scope?: Skill.SkillAccessScope) => Effect.Effect<string | undefined>
}

export class Service extends Context.Service<Service, Interface>()("@jyycode/SystemPrompt") {}

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const skill = yield* Skill.Service

    return Service.of({
      environment: Effect.fn("SystemPrompt.environment")(function* (model: Provider.Model, input?: { child?: boolean }) {
        const ctx = yield* InstanceState.context
        const workspace = input?.child
          ? [
              "## Child workspace boundary",
              "- Your only filesystem boundary is workspace_root in the dispatch brief.",
              "- Do not infer, request, or access the parent Agent's workspace. Resolve every task path from workspace_root.",
            ]
          : [`Working directory: ${ctx.directory}`, `Workspace root: ${ctx.worktree}`]
        return [
          [
            "## Runtime context",
            `Model: ${model.providerID}/${model.api.id}`,
            ...workspace,
            `Git repository: ${ctx.project.vcs === "git" ? "yes" : "no"}`,
            RUNTIME_CONTRACT,
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
