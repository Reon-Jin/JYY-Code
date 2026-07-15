import type { AgentClusterConfig, Config } from "@jyycode-ai/sdk/v2/client"
import type { DesktopClient } from "../../data/sdk"
import type { CatalogModel, ModelSelection } from "../composer/model-catalog"

export const clusterModelRoles = [
  {
    key: "planner_model",
    label: "主模型",
    description: "单智能体对话，以及多智能体的规划、调度、复核和最终汇总",
  },
  { key: "simple_model", label: "简单任务", description: "收集、摘要和普通草稿" },
  { key: "complex_model", label: "复杂任务", description: "复杂分析与实现任务" },
  { key: "visual_model", label: "视觉与文档", description: "图片、图表、PDF 和文档制作" },
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
