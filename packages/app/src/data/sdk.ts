import { createJyycodeClient } from "@jyycode-ai/sdk/v2/client"
import type { DesktopBootstrap } from "../platform/types"

export function authorizationHeader(username: string, password: string) {
  return `Basic ${btoa(`${username}:${password}`)}`
}

export function createDesktopClient(input: DesktopBootstrap, directory?: string) {
  return createJyycodeClient({
    baseUrl: input.baseUrl,
    directory,
    headers: { Authorization: authorizationHeader(input.username, input.password) },
  })
}

export type DesktopClient = ReturnType<typeof createDesktopClient>
