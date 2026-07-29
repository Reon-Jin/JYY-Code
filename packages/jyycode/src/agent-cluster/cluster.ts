export * as AgentCluster from "./cluster"

import { ConfigAgentCluster } from "@/config/agent-cluster"
import { MailSession } from "@/communication/mail-session"
import { Provider } from "@/provider/provider"
import { ModelID, ProviderID } from "@/provider/schema"
import type { Session } from "@/session/session"
import type { PromptInput } from "@/session/prompt"
import type { SessionID } from "@/session/schema"
import { Effect } from "effect"
import path from "path"
import { runInstructions } from "./planner"

type ModelRef = {
  providerID: ProviderID
  modelID: ModelID
  variant?: string
}

type ClusterModels = {
  planner: ModelRef
  simple: ModelRef
  complex: ModelRef
  visual: ModelRef
}

/** Multi-agent mode selection and prompt decoration. Execution is owned by WorkflowRuntime. */
export function isMailSession(session: Pick<Session.Info, "title" | "agent" | "path">) {
  if (MailSession.isMailSessionTitle(session.title)) return true
  if (session.agent === "mail") return true
  return session.path === "mail"
}

export function canUseAgentCluster(input: {
  session: Pick<Session.Info, "title" | "agent" | "path" | "multiAgent" | "parentID">
  config: ConfigAgentCluster.Info | undefined
  requested?: boolean
}) {
  const config = ConfigAgentCluster.resolve(input.config)
  if (config.enabled !== true) return false
  if (isMailSession(input.session)) return false
  if (input.session.parentID) return false
  return (input.requested ?? input.session.multiAgent ?? config.default_on) === true
}

export const resolveModelRef = Effect.fn("AgentCluster.resolveModelRef")(function* (model: string, variant?: string) {
  const provider = yield* Provider.Service
  const normalizedVariant = variant?.trim() || undefined
  if (model.includes("/")) {
    const parsed = Provider.parseModel(model)
    const info = yield* provider.getModel(parsed.providerID, parsed.modelID)
    if (normalizedVariant && !info.variants?.[normalizedVariant]) {
      return yield* Effect.fail(new Error(`Multi-agent model variant not found: ${model}/${normalizedVariant}`))
    }
    return normalizedVariant ? { ...parsed, variant: normalizedVariant } : parsed
  }
  const providers = yield* provider.list()
  const matches = Object.values(providers)
    .filter((item) => item.models[model])
    .map((item) => ({ providerID: item.id, modelID: ModelID.make(model) }))
  if (matches.length === 1) {
    const parsed = matches[0]!
    const info = yield* provider.getModel(parsed.providerID, parsed.modelID)
    if (normalizedVariant && !info.variants?.[normalizedVariant]) {
      return yield* Effect.fail(new Error(`Multi-agent model variant not found: ${model}/${normalizedVariant}`))
    }
    return normalizedVariant ? { ...parsed, variant: normalizedVariant } : parsed
  }
  if (matches.length > 1) return yield* Effect.fail(new Error(`Multi-agent model "${model}" is ambiguous; use provider/model`))
  return yield* Effect.fail(new Error(`Multi-agent model not found: ${model}`))
})

export const resolveModels = Effect.fn("AgentCluster.resolveModels")(function* (config: ConfigAgentCluster.Info) {
  const resolved = ConfigAgentCluster.resolve(config)
  return yield* Effect.all({
    planner: resolveModelRef(resolved.planner_model, resolved.planner_variant),
    simple: resolveModelRef(resolved.simple_model, resolved.simple_variant),
    complex: resolveModelRef(resolved.complex_model, resolved.complex_variant),
    visual: resolveModelRef(resolved.visual_model, resolved.visual_variant),
  }, { concurrency: "unbounded" })
})

export function formatModel(model: ModelRef) {
  return `${model.providerID}/${model.modelID}`
}

export function artifactDir(input: { session: Pick<Session.Info, "directory">; config: ConfigAgentCluster.Info }) {
  const config = ConfigAgentCluster.resolve(input.config)
  return path.isAbsolute(config.artifact_dir) ? config.artifact_dir : path.join(input.session.directory, config.artifact_dir)
}

export function decoratePromptInput(input: {
  prompt: PromptInput
  sessionID: SessionID
  session: Pick<Session.Info, "directory">
  config: ConfigAgentCluster.Info
  models: ClusterModels
  taskGraph?: readonly {
    id: string
    step: number
    status: string
    title: string
    role: string
    prompt: string
    complexity: string
    model: string
    dependencies: readonly string[]
    acceptance_criteria: readonly string[]
    artifact_paths: readonly string[]
    review_issues: readonly string[]
    last_event: string | null
  }[]
  reusableSubagents?: readonly {
    sessionID: string
    lastTaskID: string
    role: string
    title: string
    status: string
  }[]
}): PromptInput {
  const config = ConfigAgentCluster.resolve(input.config)
  const plannerModel = input.prompt.model ?? input.models.planner
  return {
    ...input.prompt,
    agent: "cluster",
    ...(input.prompt.variant || input.prompt.model ? {} : input.models.planner.variant ? { variant: input.models.planner.variant } : {}),
    model: plannerModel,
    parts: [
      ...input.prompt.parts,
      {
        type: "text" as const,
        synthetic: true,
        text: runInstructions({
          sessionID: input.sessionID,
          artifactDir: artifactDir({ session: input.session, config }),
          simpleModel: formatModel(input.models.simple),
          complexModel: formatModel(input.models.complex),
          visualModel: formatModel(input.models.visual),
          maxSubagents: config.max_subagents,
          maxConcurrency: config.max_concurrency,
          maxReviewRounds: config.max_review_rounds,
          taskGraph: input.taskGraph,
          reusableSubagents: input.reusableSubagents,
        }),
        metadata: { kind: "agent_cluster", sessionID: input.sessionID },
      },
    ],
  }
}
