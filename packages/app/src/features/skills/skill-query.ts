import type { AppSkillsResponse, JyycodeClient } from "@jyycode-ai/sdk/v2/client"
import type { QueryClient } from "@tanstack/solid-query"
import { keys } from "../../data/query-keys"

export type ManagedSkill = AppSkillsResponse[number]

export type SkillQueryInput = {
  client: Pick<JyycodeClient, "app">
  directory: string
  signal?: AbortSignal
}

export async function loadManagementSkills(input: SkillQueryInput) {
  const result = await input.client.app.skills(
    { directory: input.directory, scope: "global" },
    input.signal ? { throwOnError: true, signal: input.signal } : { throwOnError: true },
  )
  return result.data ?? []
}

export function managementSkillsQueryOptions(input: SkillQueryInput) {
  return {
    queryKey: keys.managementSkills,
    queryFn: ({ signal }: { signal: AbortSignal }) => loadManagementSkills({ ...input, signal }),
  } as const
}

export async function refreshManagementSkills(queryClient: QueryClient, name?: string) {
  await queryClient.invalidateQueries({ queryKey: keys.managementSkills })
  if (name) await queryClient.invalidateQueries({ queryKey: keys.managementSkill(name) })
}
