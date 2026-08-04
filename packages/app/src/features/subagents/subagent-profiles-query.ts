import type { QueryClient } from "@tanstack/solid-query"
import type { SubagentProfile, SubagentProfileView } from "@jyycode-ai/sdk/v2/client"
import type { DesktopClient } from "../../data/sdk"
import { keys } from "../../data/query-keys"

type SubagentClient = Pick<DesktopClient, "subagents" | "tool">

export type SubagentProfilesQueryInput = {
  client: SubagentClient
  directory: string
  signal?: AbortSignal
}

function options(signal?: AbortSignal) {
  return signal ? { throwOnError: true as const, signal } : { throwOnError: true as const }
}

export async function loadSubagentProfiles(input: SubagentProfilesQueryInput): Promise<SubagentProfileView[]> {
  const response = await input.client.subagents.list({ directory: input.directory }, options(input.signal))
  return response.data ?? []
}

export async function loadSubagentToolIDs(input: SubagentProfilesQueryInput): Promise<string[]> {
  const response = await input.client.tool.ids({ directory: input.directory }, options(input.signal))
  return response.data ?? []
}

export function subagentProfilesQueryOptions(input: SubagentProfilesQueryInput) {
  return {
    queryKey: keys.subagents(input.directory),
    queryFn: ({ signal }: { signal: AbortSignal }) => loadSubagentProfiles({ ...input, signal }),
  } as const
}

export function subagentToolIDsQueryOptions(input: SubagentProfilesQueryInput) {
  return {
    queryKey: keys.subagentTools(input.directory),
    queryFn: ({ signal }: { signal: AbortSignal }) => loadSubagentToolIDs({ ...input, signal }),
  } as const
}

export async function updateSubagentProfiles(input: {
  client: SubagentClient
  directory: string
  profiles: readonly SubagentProfile[]
}) {
  const response = await input.client.subagents.update(
    { directory: input.directory, subagentProfilesUpdate: { profiles: [...input.profiles] } },
    { throwOnError: true },
  )
  return response.data ?? []
}

export async function deleteSubagentProfile(input: { client: SubagentClient; directory: string; roleID: string }) {
  const response = await input.client.subagents.delete(
    { directory: input.directory, roleID: input.roleID },
    { throwOnError: true },
  )
  return response.data ?? []
}

export async function createSubagentSkill(input: {
  client: SubagentClient
  directory: string
  roleID: string
  name: string
  content: string
}) {
  const response = await input.client.subagents.skillCreate(
    {
      directory: input.directory,
      roleID: input.roleID,
      name: input.name,
      content: input.content,
    },
    { throwOnError: true },
  )
  return response.data
}

export async function refreshSubagentProfiles(queryClient: QueryClient, directory: string) {
  await queryClient.invalidateQueries({ queryKey: keys.subagents(directory), exact: true })
}
