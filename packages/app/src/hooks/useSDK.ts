import { createMemo } from "solid-js"
import { ApiClient } from "../api"
import { useAppState } from "../stores/app"

export function useSDK() {
  const state = useAppState()

  return createMemo(() => {
    if (!state.baseUrl) return null
    return new ApiClient(state.baseUrl, state.activeWorkspaceDir ?? undefined)
  })
}
