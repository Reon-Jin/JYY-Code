import type { JyycodeClient, McpLocalConfig, McpRemoteConfig, McpStatus } from "@jyycode-ai/sdk/v2/client"
import type { QueryClient } from "@tanstack/solid-query"
import { keys } from "../../data/query-keys"

export type McpConfig = McpLocalConfig | McpRemoteConfig

export type ManagedMcp = {
  name: string
  config: McpConfig
  status: McpStatus
}

type McpQueryInput = {
  client: Pick<JyycodeClient, "mcp">
  directory: string
  signal?: AbortSignal
}

const requestOptions = (signal?: AbortSignal) =>
  signal ? { throwOnError: true as const, signal } : { throwOnError: true as const }

export async function loadManagementMcpConfig(input: McpQueryInput) {
  const result = await input.client.mcp.config.list({ directory: input.directory }, requestOptions(input.signal))
  return result.data ?? {}
}

export async function loadManagementMcpStatus(input: McpQueryInput) {
  const result = await input.client.mcp.status({ directory: input.directory }, requestOptions(input.signal))
  return result.data ?? {}
}

export function mergeManagedMcp(configs: Record<string, McpConfig>, statuses: Record<string, McpStatus>): ManagedMcp[] {
  return Object.entries(configs)
    .map(([name, config]) => ({
      name,
      config,
      status:
        statuses[name] ??
        ({ status: config.enabled === false ? "disabled" : "failed", error: "状态未知" } as McpStatus),
    }))
    .sort((left, right) => left.name.localeCompare(right.name))
}

export function managementMcpConfigQueryOptions(input: McpQueryInput) {
  return {
    queryKey: keys.managementMcpConfig,
    queryFn: ({ signal }: { signal: AbortSignal }) => loadManagementMcpConfig({ ...input, signal }),
  } as const
}

export function managementMcpStatusQueryOptions(input: McpQueryInput) {
  return {
    queryKey: keys.managementMcpStatus,
    queryFn: ({ signal }: { signal: AbortSignal }) => loadManagementMcpStatus({ ...input, signal }),
    refetchInterval: () => (document.visibilityState === "visible" ? 5_000 : false),
  } as const
}

export async function refreshManagementMcp(queryClient: QueryClient, includeConfig = false) {
  const tasks = [queryClient.invalidateQueries({ queryKey: keys.managementMcpStatus })]
  if (includeConfig) tasks.push(queryClient.invalidateQueries({ queryKey: keys.managementMcpConfig }))
  await Promise.all(tasks)
}
