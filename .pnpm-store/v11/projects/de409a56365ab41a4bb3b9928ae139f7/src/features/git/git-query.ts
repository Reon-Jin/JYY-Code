import type { VcsBranches, VcsCreateBranchInput, VcsPushInput, VcsSwitchBranchInput } from "@jyycode-ai/sdk/v2/client"
import type { QueryClient } from "@tanstack/solid-query"
import type { DesktopClient } from "../../data/sdk"
import { keys } from "../../data/query-keys"

type GitClient = Pick<DesktopClient, "vcs">

export type GitQueryInput = {
  client: GitClient
  directory: string
  signal?: AbortSignal
}

const requestOptions = (signal?: AbortSignal) =>
  signal ? ({ throwOnError: true, signal } as const) : ({ throwOnError: true } as const)

export async function loadVcsInfo(input: GitQueryInput) {
  const result = await input.client.vcs.get({ directory: input.directory }, requestOptions(input.signal))
  return result.data ?? {}
}

export async function loadVcsBranches(input: GitQueryInput) {
  const result = await input.client.vcs.branch.list({ directory: input.directory }, requestOptions(input.signal))
  return result.data ?? { branches: [], remotes: [] }
}

export function vcsInfoQueryOptions(input: GitQueryInput) {
  return {
    queryKey: keys.vcsInfo(input.directory),
    queryFn: ({ signal }: { signal: AbortSignal }) => loadVcsInfo({ ...input, signal }),
  } as const
}

export function vcsBranchesQueryOptions(input: GitQueryInput) {
  return {
    queryKey: keys.vcsBranches(input.directory),
    queryFn: ({ signal }: { signal: AbortSignal }) => loadVcsBranches({ ...input, signal }),
  } as const
}

export function createGitApi(input: GitQueryInput & { queryClient: QueryClient }) {
  const setBranches = (branches: VcsBranches) => {
    input.queryClient.setQueryData(keys.vcsBranches(input.directory), branches)
    input.queryClient.setQueryData(
      keys.vcsInfo(input.directory),
      (current: { default_branch?: string } | undefined) => ({
        ...current,
        branch: branches.current,
      }),
    )
  }
  const invalidateSideEffects = async () => {
    await Promise.all([
      input.queryClient.invalidateQueries({ queryKey: keys.vcsDiff(input.directory), exact: true }),
      input.queryClient.invalidateQueries({ queryKey: keys.pullRequestsScope(input.directory), exact: false }),
    ])
  }
  const resultBranches = (data: VcsBranches | undefined) => data ?? { branches: [], remotes: [] }

  async function createBranch(value: VcsCreateBranchInput) {
    const result = await input.client.vcs.branch.create(
      { directory: input.directory, vcsCreateBranchInput: value },
      { throwOnError: true },
    )
    const branches = resultBranches(result.data)
    setBranches(branches)
    await invalidateSideEffects()
    return branches
  }

  async function switchBranch(value: VcsSwitchBranchInput) {
    const result = await input.client.vcs.branch.switch(
      { directory: input.directory, vcsSwitchBranchInput: value },
      { throwOnError: true },
    )
    const branches = resultBranches(result.data)
    setBranches(branches)
    await invalidateSideEffects()
    return branches
  }

  async function fetch() {
    const result = await input.client.vcs.fetch({ directory: input.directory }, { throwOnError: true })
    const branches = resultBranches(result.data)
    setBranches(branches)
    await invalidateSideEffects()
    return branches
  }

  async function push(value: VcsPushInput = {}) {
    const result = await input.client.vcs.push(
      { directory: input.directory, vcsPushInput: value },
      { throwOnError: true },
    )
    const branches = resultBranches(result.data)
    setBranches(branches)
    await invalidateSideEffects()
    return branches
  }

  return { createBranch, switchBranch, fetch, push }
}
