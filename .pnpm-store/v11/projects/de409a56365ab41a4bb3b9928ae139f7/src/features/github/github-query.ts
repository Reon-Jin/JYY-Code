import type { GitHubAvailability, GitHubPullRequestDetail, GitHubPullRequestSummary } from "@jyycode-ai/sdk/v2/client"
import type { QueryClient } from "@tanstack/solid-query"
import type { DesktopClient } from "../../data/sdk"
import { keys } from "../../data/query-keys"

export type PullRequestState = "open" | "closed" | "merged" | "all"
type GitHubClient = Pick<DesktopClient, "github">

export type GitHubQueryInput = {
  client: GitHubClient
  directory: string
  signal?: AbortSignal
}

const requestOptions = (signal?: AbortSignal) =>
  signal ? ({ throwOnError: true, signal } as const) : ({ throwOnError: true } as const)

export async function loadGitHubStatus(input: GitHubQueryInput) {
  const result = await input.client.github.status({ directory: input.directory }, requestOptions(input.signal))
  return result.data as GitHubAvailability | undefined
}

export async function loadPullRequests(input: GitHubQueryInput & { state: PullRequestState }) {
  const result = await input.client.github.pull.list(
    { directory: input.directory, state: input.state },
    requestOptions(input.signal),
  )
  return (result.data ?? []) as GitHubPullRequestSummary[]
}

export async function loadPullRequest(input: GitHubQueryInput & { number: number }) {
  const result = await input.client.github.pull.get(
    { directory: input.directory, number: String(input.number) },
    requestOptions(input.signal),
  )
  return result.data as GitHubPullRequestDetail | undefined
}

export async function loadPullRequestDiff(input: GitHubQueryInput & { number: number }) {
  const result = await input.client.github.pull.diff(
    { directory: input.directory, number: String(input.number) },
    requestOptions(input.signal),
  )
  return result.data ?? ""
}

export const githubStatusQueryOptions = (input: GitHubQueryInput) => ({
  queryKey: keys.githubStatus(input.directory),
  queryFn: ({ signal }: { signal: AbortSignal }) => loadGitHubStatus({ ...input, signal }),
})

export const pullRequestsQueryOptions = (input: GitHubQueryInput & { state: PullRequestState }) => ({
  queryKey: keys.pullRequests(input.directory, input.state),
  queryFn: ({ signal }: { signal: AbortSignal }) => loadPullRequests({ ...input, signal }),
})

export const pullRequestQueryOptions = (input: GitHubQueryInput & { number: number }) => ({
  queryKey: keys.pullRequest(input.directory, input.number),
  queryFn: ({ signal }: { signal: AbortSignal }) => loadPullRequest({ ...input, signal }),
})

export const pullRequestDiffQueryOptions = (input: GitHubQueryInput & { number: number }) => ({
  queryKey: keys.pullRequestDiff(input.directory, input.number),
  queryFn: ({ signal }: { signal: AbortSignal }) => loadPullRequestDiff({ ...input, signal }),
})

export function createGitHubApi(input: GitHubQueryInput & { queryClient: QueryClient }) {
  const invalidateLists = () =>
    input.queryClient.invalidateQueries({ queryKey: keys.pullRequestsScope(input.directory), exact: false })
  const invalidateDetail = (number: number) =>
    input.queryClient.invalidateQueries({ queryKey: keys.pullRequest(input.directory, number), exact: true })
  const invalidateWorkspace = () =>
    Promise.all([
      input.queryClient.invalidateQueries({ queryKey: keys.vcsInfo(input.directory), exact: true }),
      input.queryClient.invalidateQueries({ queryKey: keys.vcsBranches(input.directory), exact: true }),
      input.queryClient.invalidateQueries({ queryKey: keys.vcsDiff(input.directory), exact: true }),
    ])
  const number = (value: number) => String(value)

  async function create(value: { head: string; base: string; title: string; body: string; draft?: boolean }) {
    const result = await input.client.github.pull.create(
      { directory: input.directory, ...value },
      { throwOnError: true },
    )
    await invalidateLists()
    return result.data
  }

  async function edit(value: { number: number; title: string; body: string }) {
    const result = await input.client.github.pull.edit(
      { directory: input.directory, ...value, number: number(value.number) },
      { throwOnError: true },
    )
    await Promise.all([invalidateLists(), invalidateDetail(value.number)])
    return result.data
  }

  async function comment(value: { number: number; body: string }) {
    const result = await input.client.github.pull.comment(
      { directory: input.directory, ...value, number: number(value.number) },
      { throwOnError: true },
    )
    await invalidateDetail(value.number)
    return result.data
  }

  const mutate = async (operation: "checkout" | "close" | "reopen", value: { number: number; branch?: string }) => {
    const result = await input.client.github.pull[operation](
      { directory: input.directory, number: number(value.number) },
      { throwOnError: true },
    )
    await Promise.all([
      invalidateLists(),
      invalidateDetail(value.number),
      ...(operation === "checkout" ? [invalidateWorkspace()] : []),
    ])
    if (operation === "checkout" && value.branch) {
      input.queryClient.setQueryData(keys.vcsInfo(input.directory), (current: object | undefined) => ({
        ...current,
        branch: value.branch,
      }))
      input.queryClient.setQueryData(
        keys.vcsBranches(input.directory),
        (current: { branches?: Array<{ name: string; current: boolean }> } | undefined) => ({
          ...current,
          current: value.branch,
          branches: current?.branches?.map((branch) => ({ ...branch, current: branch.name === value.branch })) ?? [],
        }),
      )
    }
    return result.data
  }

  async function merge(value: { number: number; method: "merge" | "squash" | "rebase"; deleteBranch?: boolean }) {
    const result = await input.client.github.pull.merge(
      { directory: input.directory, ...value, number: number(value.number) },
      { throwOnError: true },
    )
    await Promise.all([invalidateLists(), invalidateDetail(value.number), invalidateWorkspace()])
    return result.data
  }

  return {
    create,
    edit,
    comment,
    checkout: (value: { number: number; branch?: string }) => mutate("checkout", value),
    close: (value: { number: number }) => mutate("close", value),
    reopen: (value: { number: number }) => mutate("reopen", value),
    merge,
  }
}
