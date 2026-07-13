import type { Agent, Config, Provider } from "@jyycode-ai/sdk/v2/client"
import type { DesktopClient } from "../../data/sdk"

const PREFERENCE_KEY = "jyycode.desktop.composer-preference"

export type ModelSelection = {
  providerID: string
  modelID: string
}

export type ComposerPreference = {
  agent?: string
  model?: ModelSelection
}

export type CatalogModel = ModelSelection & {
  providerName: string
  modelName: string
}

export type ModelCatalog = {
  agents: Agent[]
  models: CatalogModel[]
  selectedAgent: string
  selectedModel?: ModelSelection
  configPath: string
}

type CatalogClient = Pick<DesktopClient, "app" | "config" | "path" | "provider">

function parseModel(value: string | undefined): ModelSelection | undefined {
  if (!value) return undefined
  const slash = value.indexOf("/")
  if (slash <= 0 || slash === value.length - 1) return undefined
  return { providerID: value.slice(0, slash), modelID: value.slice(slash + 1) }
}

function isModelSelection(value: unknown): value is ModelSelection {
  if (!value || typeof value !== "object") return false
  const candidate = value as Record<string, unknown>
  return typeof candidate.providerID === "string" && typeof candidate.modelID === "string"
}

export function parseComposerPreference(value: unknown): ComposerPreference {
  if (!value || typeof value !== "object") return {}
  const candidate = value as Record<string, unknown>
  return {
    ...(typeof candidate.agent === "string" ? { agent: candidate.agent } : {}),
    ...(isModelSelection(candidate.model) ? { model: candidate.model } : {}),
  }
}

type PreferenceStorage = Pick<Storage, "getItem" | "setItem">

function defaultStorage() {
  if (typeof localStorage === "undefined") return undefined
  return localStorage
}

export function loadComposerPreference(storage: PreferenceStorage | undefined = defaultStorage()) {
  if (!storage) return {}
  try {
    const value = storage.getItem(PREFERENCE_KEY)
    return value === null ? {} : parseComposerPreference(JSON.parse(value))
  } catch {
    return {}
  }
}

export function saveComposerPreference(
  preference: ComposerPreference,
  storage: PreferenceStorage | undefined = defaultStorage(),
) {
  if (!storage) return
  const value = parseComposerPreference(preference)
  try {
    storage.setItem(PREFERENCE_KEY, JSON.stringify(value))
  } catch {
    // A read-only browser storage must not block sending a message.
  }
}

function dataOrThrow<T>(response: { data?: T }, name: string): T {
  if (response.data === undefined) throw new Error(`${name} did not return data`)
  return response.data
}

function globalConfigPath(configDirectory: string) {
  const separator = configDirectory.includes("\\") ? "\\" : "/"
  return `${configDirectory.replace(/[\\/]+$/, "")}${separator}jyycode.jsonc`
}

function modelKey(model: ModelSelection) {
  return `${model.providerID}/${model.modelID}`
}

function chooseModel(candidates: Array<ModelSelection | undefined>, models: readonly CatalogModel[]) {
  const available = new Set(models.map(modelKey))
  return candidates.find((candidate) => candidate && available.has(modelKey(candidate)))
}

export async function loadModelCatalog(input: {
  client: CatalogClient
  directory: string
  preference?: ComposerPreference
}): Promise<ModelCatalog> {
  const options = { throwOnError: true } as const
  const [agentsResponse, configuredResponse, providersResponse, configResponse, pathResponse] = await Promise.all([
    input.client.app.agents({ directory: input.directory }, options),
    input.client.config.providers({ directory: input.directory }, options),
    input.client.provider.list({ directory: input.directory }, options),
    input.client.config.get({ directory: input.directory }, options),
    input.client.path.get({ directory: input.directory }, options),
  ])
  const allAgents = dataOrThrow(agentsResponse, "app.agents")
  const configured = dataOrThrow(configuredResponse, "config.providers")
  const providers = dataOrThrow(providersResponse, "provider.list")
  const config = dataOrThrow(configResponse, "config.get") as Config
  const paths = dataOrThrow(pathResponse, "path.get")
  const preference = parseComposerPreference(input.preference)

  const agents = allAgents.filter((candidate) => candidate.mode !== "subagent" && !candidate.hidden)
  const agentNames = new Set(agents.map((candidate) => candidate.name))
  const selectedAgent =
    [preference.agent, config.default_agent, "build", agents.find((candidate) => candidate.mode === "primary")?.name].find(
      (candidate) => candidate && agentNames.has(candidate),
    ) ?? agents[0]?.name ?? "build"

  const configuredByID = new Map(configured.providers.map((provider) => [provider.id, provider]))
  const allByID = new Map(providers.all.map((provider) => [provider.id, provider]))
  const connectedProviders = providers.connected
    .map((providerID) => configuredByID.get(providerID) ?? allByID.get(providerID))
    .filter((provider): provider is Provider => Boolean(provider))
  const models = connectedProviders.flatMap((provider) =>
    Object.values(provider.models).map((model) => ({
      providerID: provider.id,
      providerName: provider.name,
      modelID: model.id,
      modelName: model.name,
    })),
  )
  const agentModel = agents.find((candidate) => candidate.name === selectedAgent)?.model
  const defaultModels = connectedProviders.flatMap((provider) => [
    configured.default[provider.id]
      ? { providerID: provider.id, modelID: configured.default[provider.id]! }
      : undefined,
    providers.default[provider.id] ? { providerID: provider.id, modelID: providers.default[provider.id]! } : undefined,
  ])
  const selectedModel = chooseModel(
    [preference.model, agentModel, parseModel(config.model), ...defaultModels, models[0]],
    models,
  )

  return {
    agents,
    models,
    selectedAgent,
    selectedModel,
    configPath: globalConfigPath(paths.config),
  }
}
