import type { AgentClusterConfig, Config } from "@jyycode-ai/sdk/v2/client"
import type { DesktopClient } from "../../data/sdk"
import { tr } from "../../i18n/i18n-context"
import type { CatalogModel, ModelSelection } from "../composer/model-catalog"

export const clusterModelRoles = [
  {
    key: "planner_model",
    get label() { return tr("multi-agent.model-role-main") },
    get description() { return tr("multi-agent.model-role-main-description") },
  },
  {
    key: "simple_model",
    get label() { return tr("multi-agent.model-role-simple") },
    get description() { return tr("multi-agent.model-role-simple-description") },
  },
  {
    key: "complex_model",
    get label() { return tr("multi-agent.model-role-complex") },
    get description() { return tr("multi-agent.model-role-complex-description") },
  },
  {
    key: "visual_model",
    get label() { return tr("multi-agent.model-role-visual") },
    get description() { return tr("multi-agent.model-role-visual-description") },
  },
] as const

export type ClusterModelRoleKey = (typeof clusterModelRoles)[number]["key"]
export type ClusterModelSelections = Record<ClusterModelRoleKey, ModelSelection>

type GlobalConfigClient = Pick<DesktopClient, "global">

export function parseClusterModelValue(value: string | undefined): ModelSelection | undefined {
  if (!value) return undefined
  const slash = value.indexOf("/")
  if (slash <= 0 || slash === value.length - 1) return undefined
  return { providerID: value.slice(0, slash), modelID: value.slice(slash + 1) }
}

export function formatClusterModelValue(model: ModelSelection) {
  return `${model.providerID}/${model.modelID}`
}

export function clusterModelLabel(model: CatalogModel) {
  return `${model.providerName} · ${model.modelName}`
}

export function resolveClusterModel(value: string | undefined, models: readonly CatalogModel[]) {
  if (!value) return undefined
  const explicit = parseClusterModelValue(value)
  if (explicit) {
    return models.find(
      (model) => model.providerID === explicit.providerID && model.modelID === explicit.modelID,
    )
  }
  const matches = models.filter((model) => model.modelID === value)
  return matches.length === 1 ? matches[0] : undefined
}

function dataOrThrow<T>(response: { data?: T }, name: string): T {
  if (response.data === undefined) throw new Error(`${name} did not return data`)
  return response.data
}

export async function loadClusterModelConfig(client: GlobalConfigClient) {
  const response = await client.global.config.get({ throwOnError: true })
  return (dataOrThrow(response, "global.config.get") as Config).agent_cluster ?? {}
}

export async function saveClusterModelConfig(client: GlobalConfigClient, selections: ClusterModelSelections) {
  const agentCluster = Object.fromEntries(
    clusterModelRoles.map((role) => [role.key, formatClusterModelValue(selections[role.key])]),
  ) as Record<ClusterModelRoleKey, string>
  const response = await client.global.config.update(
    { config: { agent_cluster: agentCluster } },
    { throwOnError: true },
  )
  return dataOrThrow(response, "global.config.update")
}
