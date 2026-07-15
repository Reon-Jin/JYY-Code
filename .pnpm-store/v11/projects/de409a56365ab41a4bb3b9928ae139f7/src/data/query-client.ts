import { QueryClient } from "@tanstack/solid-query"

function isNetworkFailure(error: Error) {
  if (error instanceof TypeError) return true
  if (error.name === "AbortError") return false

  const cause = error.cause
  if (!cause || typeof cause !== "object") return false
  const status = (cause as { status?: unknown }).status
  return status === undefined && error.message.toLocaleLowerCase("en-US").includes("network")
}

export function createDesktopQueryClient() {
  return new QueryClient({
    defaultOptions: {
      queries: {
        staleTime: 30_000,
        retry: (failureCount, error) => failureCount < 2 && isNetworkFailure(error),
      },
      mutations: {
        retry: false,
      },
    },
  })
}
